/* eslint no-underscore-dangle: ["error", { "allowAfterThis": true }] */

'use strict';

const fs = require('fs');
const joi = require('joi');
const boom = require('@hapi/boom');
const hoek = require('@hapi/hoek');
const path = require('path');
const request = require('screwdriver-request');
const { v4: uuidv4 } = require('uuid');
const logger = require('screwdriver-logger');
const CoverageBase = require('screwdriver-coverage-base');

const COMMANDS = fs.readFileSync(path.join(__dirname, 'commands.txt'), 'utf8').trim();
const DEFAULT_GIT_APP_NAME = 'Screwdriver Sonar PR Checks';

class CoverageSonar extends CoverageBase {
    /**
     * Constructor
     * @method constructor
     * @param  {Object}  config                     Configuration object
     * @param  {String}  config.sdApiUrl            URL for Screwdriver API
     * @param  {String}  config.sdUiUrl             URL for Screwdriver UI
     * @param  {String}  config.sonarHost           SonarQube Server host
     * @param  {String}  config.adminToken          Sonar Admin token
     * @param  {Boolean} [config.sonarEnterprise]   If Sonar enterprise is used or not
     *
     */
    constructor(config) {
        super();

        this.config = joi.attempt(
            config,
            joi
                .object()
                .keys({
                    sdApiUrl: joi.string().uri().required(),
                    sdUiUrl: joi.string().uri().required(),
                    sonarHost: joi.string().uri().required(),
                    adminToken: joi.string().required(),
                    sonarEnterprise: joi.boolean().default(false),
                    sonarGitAppName: joi.string().default(DEFAULT_GIT_APP_NAME)
                })
                .unknown(true),
            'Invalid config for sonar coverage plugin'
        );

        // use this.config for default values
        this.sdCoverageAuthUrl = `${this.config.sdApiUrl}/v4/coverage/token`;
        this.adminToken = this.config.adminToken;
        this.sonarHost = this.config.sonarHost;
        this.sonarEnterprise = this.config.sonarEnterprise;
        this.sonarGitAppName = this.config.sonarGitAppName;

        this.uploadCommands = COMMANDS.replace('$SD_SONAR_HOST', this.sonarHost)
            .replace('$SD_UI_URL', this.config.sdUiUrl)
            .replace('$SD_SONAR_ENTERPRISE', this.sonarEnterprise)
            .split('\n');

        this.uploadCommands[this.uploadCommands.length - 1] += ' || true';
    }

    /**
     * Create a project in sonar
     * @method createProject
     * @param  {String} projectKey    Unique identifier for the project
     * @return {Promise}              Project object if it gets created or empty object if already exists
     */
    createProject(projectKey) {
        return request({
            method: 'POST',
            url: `${this.sonarHost}/api/projects/create?project=${projectKey}&name=${projectKey}`,
            username: this.adminToken
        }).catch(err => {
            if (err.statusCode === 400 && err.message.includes('already exists')) {
                return {};
            }

            throw new Error(`Failed to create project ${projectKey}: ${err.message}`);
        });
    }

    /**
     * Create a user in sonar
     * @method createUser
     * @param  {String} username  Username of the user
     * @param  {String} password  Password of the user
     * @return {Promise}          User object if it gets created or empty object if already exists
     */
    createUser(username, password) {
        return request({
            method: 'POST',
            url: `${this.sonarHost}/api/users/create?login=${username}&name=${username}&password=${password}`,
            username: this.adminToken
        }).catch(err => {
            if (err.statusCode === 400 && err.message.includes('already exists')) {
                return {};
            }

            throw new Error(`Failed to create user ${username}: ${err.message}`);
        });
    }

    /**
     * Returns the configured Git App name for the given SCM context
     * @param {String} scmContext SCM context in format "scm:host" (e.g., "github:github.com")
     * @returns {String} Git App name
     */
    async _getGitApp(scmContext) {
        const scmHost = scmContext && scmContext.includes(':') ? scmContext.split(':')[1] : scmContext;

        if (!scmHost) {
            logger.error('Invalid scmContext provided; using default Git App name');

            return this.sonarGitAppName;
        }

        const { body } = await request({
            method: 'GET',
            url: `${this.sonarHost}/api/alm_settings/list`,
            username: this.adminToken
        });

        const almSettings = (body && body.almSettings) || [];

        if (almSettings.length === 0) {
            logger.error('No ALM settings found in SonarQube; using default Git App name');

            return this.sonarGitAppName;
        }
        if (almSettings.length === 1) {
            return almSettings[0].key;
        }

        const gitAppSetting = almSettings.find(app => app.key.endsWith(`[${scmHost}]`));

        if (!gitAppSetting) {
            const availableKeys = almSettings.map(app => app.key).join(', ');

            logger.error(
                `Git App for scm '[${scmHost}]' not found in SonarQube. Available keys: ${availableKeys}. Using default Git App name`
            );

            return this.sonarGitAppName;
        }

        return gitAppSetting.key;
    }

    /**
     * Normalize the repository name expected by Sonar's Git binding API.
     * Upstream callers may pass a broader project name like "org/repo:checkout-root" specific to SD pipelines, but Sonar expects just "org/repo".
     * @param {String} projectName Sonar project name
     * @returns {String} Repository slug in org/repo format when available
     */
    _getRepositoryName(projectName) {
        if (!projectName) {
            return projectName;
        }

        const [organization, repositoryWithSuffix] = projectName.split('/');

        if (!organization || !repositoryWithSuffix) {
            return projectName;
        }

        const repository = repositoryWithSuffix.split(':')[0];

        return `${organization}/${repository}`;
    }

    /**
     * Configure Git App in SonarQube
     * @param  {String} projectKey  Sonar project key
     * @param  {String} projectName Sonar project name
     * @param  {String} scmContext  SCM context (github:github.com or github:github.example.com)
     * @return {Promise}            Nothing if Git App configured successfully
     */
    async configureGitApp(projectKey, projectName, scmContext) {
        const gitApp = await this._getGitApp(scmContext);
        const gitAppEncoded = encodeURIComponent(gitApp);
        const componentId = encodeURIComponent(projectKey);
        const repositoryName = this._getRepositoryName(projectName);

        // Check if binding exists
        return request({
            method: 'GET',
            url: `${this.sonarHost}/api/alm_settings/get_binding?project=${componentId}`,
            username: this.adminToken
        })
            .then(result => {
                // if project name has been changed, update it
                if (repositoryName && (!result.repository || result.repository !== repositoryName)) {
                    throw new Error(`Repository name has been changed from ${result.repository} to ${repositoryName}!`);
                }

                return result;
            })
            .catch(() => {
                // if binding does not exist, add it
                logger.info(`Binding does not exist for Sonar project ${projectKey}, adding`);

                if (!this.sonarEnterprise || !repositoryName) {
                    return Promise.resolve();
                }

                const parameters = `almSetting=${gitAppEncoded}&project=${componentId}&repository=${repositoryName}&summaryCommentEnabled=true&monorepo=false`;

                logger.info(`Configuring git app with following parameters, ${parameters}`);

                return request({
                    method: 'POST',
                    url: `${this.sonarHost}/api/alm_settings/set_github_binding?${parameters}`,
                    username: this.adminToken
                }).catch(error => {
                    // if cannot configure app, do not throw err
                    logger.error(
                        `Failed to configure Git App ${gitApp} for Sonar project ${projectKey}: ${error.message}`
                    );

                    return Promise.resolve();
                });
            });
    }

    /**
     * Give specific user push access to the project
     * @method grantUserPermission
     * @param  {String} username      Username of the user
     * @param  {String} projectKey    Unique identifier for the project
     * @return {Promise}              Nothing if permission granted
     */
    grantUserPermission(username, projectKey) {
        // Always return 204 even with duplicate calls
        return request({
            method: 'POST',
            url: `${this.sonarHost}/api/permissions/add_user?login=${username}&permission=scan&projectKey=${projectKey}`,
            username: this.adminToken
        }).catch(err => {
            throw new Error(`Failed to grant user ${username} permission: ${err.message}`);
        });
    }

    /**
     * Generate an access token for the given user
     * @method generateToken
     * @param  {String} username   Username of the user
     * @return {Promise}           Object with a token field
     */
    generateToken(username) {
        const tokenName = uuidv4();

        return request({
            method: 'POST',
            url: `${this.sonarHost}/api/user_tokens/generate?login=${username}&name=${tokenName}`,
            username: this.adminToken
        }).catch(err => {
            throw new Error(`Failed to generate user ${username} token: ${err.message}`);
        });
    }

    /**
     * Get metrics for a project
     * @method getMetrics
     * @param  {Object} config
     * @param  {String} config.projectKey   Sonar project key (job:jobId or pipeline:pipelineId)
     * @param  {String} config.startTime    Job start time
     * @param  {String} config.endTime      Job end time
     * @param  {String} [config.prNum]      Pull request number
     * @return {Promise}                    Object with coverage percentage and tests success percentage
     */
    getMetrics({ projectKey, startTime, endTime, prNum, sonarEnterprise: enterpriseEnabled }) {
        const componentId = encodeURIComponent(projectKey);
        // get timezone offset (e.g. -0700) from 'Fri May 11 2018 15:25:37 GMT-0700 (PDT)'
        const timezoneOffset = new Date().toString().match(/GMT(.*?) /)[1];
        // Convert the time format from 2018-05-10T19:05:53.123Z to 2018-05-10T19:05:53-0700 as required by sonar
        const parsedStartTime = startTime.replace(/\.(.*)/, timezoneOffset);
        const parsedEndTime = endTime.replace(/\.(.*)/, timezoneOffset);
        const from = encodeURIComponent(parsedStartTime);
        const to = encodeURIComponent(parsedEndTime);
        let coverageUrl = `${this.sonarHost}/api/measures/search_history?component=${componentId}&metrics=tests,test_errors,test_failures,coverage&from=${from}&to=${to}&ps=1`;

        if (enterpriseEnabled && prNum) {
            coverageUrl = coverageUrl.concat(`&pullRequest=${prNum}`);
        }

        return request({
            method: 'GET',
            url: coverageUrl,
            username: this.adminToken
        })
            .then(result => {
                const measures = {};

                // measures in result is an array, covert it to an object with metric name as key
                (hoek.reach(result, 'body.measures') || []).forEach(measure => {
                    measures[measure.metric] = measure;
                });

                const metrics = {
                    coverage: hoek.reach(measures, 'coverage.history.0.value') || 'N/A',
                    tests: 'N/A'
                };
                const zero = { default: 0 };
                const total = hoek.reach(measures, 'tests.history.0.value', { default: 'N/A' });
                const testErrors = hoek.reach(measures, 'test_errors.history.0.value', zero);
                const testFailures = hoek.reach(measures, 'test_failures.history.0.value', zero);

                if (!Number.isNaN(Number(total))) {
                    const totalInt = parseInt(total, 10);
                    const pass = totalInt - parseInt(testErrors, 10) - parseInt(testFailures, 10);

                    metrics.tests = `${pass}/${totalInt}`;
                }

                return metrics;
            })
            .catch(err => {
                // if there is no coverage measurement target, 404 and 'Component key not found' are returned and this is not an error
                if (err.statusCode !== 404 || !/Component key '.*' not found/.test(err.message)) {
                    // if cannot get coverage, do not throw err
                    logger.error(
                        `Failed to get coverage and tests percentage for Sonar project ${projectKey}: ${err.message}`
                    );
                }

                return {
                    tests: 'N/A',
                    coverage: 'N/A'
                };
            });
    }

    /**
     * Determine which Sonar project keys a build is allowed to act on.
     * Derived exclusively from the build JWT, never from caller-supplied input.
     * @method getAuthorizedProjectKeys
     * @param  {Object}  buildCredentials                   Information stored in a build JWT
     * @param  {String}  [buildCredentials.jobId]           Screwdriver job ID
     * @param  {String}  [buildCredentials.pipelineId]      Screwdriver pipeline ID
     * @param  {String}  [buildCredentials.prParentJobId]   Screwdriver PR parent job ID
     * @return {Array}                                      Sonar project keys the build may use
     */
    getAuthorizedProjectKeys({ jobId, pipelineId, prParentJobId }) {
        const ids = [
            ['pipeline', pipelineId],
            ['job', jobId],
            ['job', prParentJobId]
        ];

        return ids.filter(([, id]) => id !== undefined && id !== null).map(([prefix, id]) => `${prefix}:${id}`);
    }

    /**
     * Resolve the coverage scope: the caller-configured scope when there is one, otherwise the default
     * for this SonarQube edition (pipeline for enterprise, job for everything else).
     * @method _resolveCoverageScope
     * @param  {Object}     config
     * @param  {String}     [config.scope]              Coverage scope (pipeline or job)
     * @param  {Boolean}    config.enterpriseEnabled    If enterprise is enabled
     * @return {String}                                 Resolved coverage scope
     */
    _resolveCoverageScope({ scope, enterpriseEnabled }) {
        const userScope = scope && scope !== 'undefined' ? scope : undefined;

        return userScope || (enterpriseEnabled ? 'pipeline' : 'job');
    }

    /**
     * Determine Sonar project key, project name, and username based on:
     * - SonarQube edition
     * - job annotation
     * @method getProjectData
     * @param  {Object}     config
     * @param  {Object}     [config.scope]              Coverage scope (pipeline or job)
     * @param  {Boolean}    config.enterpriseEnabled    If enterprise is enabled
     * @param  {String}     config.jobId                Screwdriver job ID
     * @param  {String}     config.jobName              Screwdriver job name
     * @param  {String}     config.pipelineId           Screwdriver pipeline ID
     * @param  {String}     config.pipelineName         Screwdriver pipeline name
     * @param  {String}     [config.projectKey]         Sonar project key
     * @param  {String}     [config.prNum]              PR number
     * @param  {String}     [config.prParentJobId]      Screwdriver PR parent job ID
     * @return {Object}                                 Sonar project key, project name, and username
     */
    getProjectData({
        scope,
        enterpriseEnabled,
        jobId: buildJobId,
        jobName: buildJobName,
        pipelineId,
        pipelineName,
        projectKey,
        prParentJobId
    }) {
        let jobId = buildJobId;
        let jobName = buildJobName;

        // Determine scope based on projectKey
        if (projectKey) {
            const [projectScope, id] = projectKey.split(':');
            const projectName = projectScope === 'pipeline' ? pipelineName : `${pipelineName}:${jobName}`;
            const username = `user-${projectScope}-${id}`;
            const projectData = {
                projectKey,
                username,
                projectName,
                projectScope
            };

            if (projectScope === 'pipeline') {
                const componentId = encodeURIComponent(`pipeline:${id}`);

                projectData.projectUrl = `${this.sonarHost}/dashboard?id=${componentId}`;
            }

            return projectData;
        }

        const coverageScope = this._resolveCoverageScope({ scope, enterpriseEnabled });

        if (coverageScope === 'pipeline') {
            const componentId = encodeURIComponent(`pipeline:${pipelineId}`);
            const projectUrl = `${this.sonarHost}/dashboard?id=${componentId}`;

            return {
                projectKey: `pipeline:${pipelineId}`,
                projectName: pipelineName,
                username: `user-pipeline-${pipelineId}`,
                projectScope: coverageScope,
                projectUrl
            };
        }

        // Use prParentJobId as ID for PRs. jobName is what identifies a PR job, so without it a PR build
        // falls back to its own job's project rather than its parent's; callers that cannot resolve jobName
        // must not crash here.
        if (coverageScope === 'job' && enterpriseEnabled && jobName) {
            const prRegex = /^PR-(\d+)(?::([\w-]+))?$/;
            const prNameMatch = jobName.match(prRegex);

            if (prNameMatch && prNameMatch.length > 1) {
                jobId = prParentJobId;
                jobName = prNameMatch[2];
            }
        }

        return {
            projectKey: `job:${jobId}`,
            projectName: `${pipelineName}:${jobName}`,
            username: `user-job-${jobId}`,
            projectScope: coverageScope
        };
    }

    /**
     * Return an access token that build can use to talk to coverage server
     * @method getAccessToken
     * @param {Object} config
     * @param {String} [config.scope]           Coverage scope
     * @param {Object} config.buildCredentials  Information stored in a build JWT
     * @param {String} [config.jobName]         Screwdriver job name
     * @param {String} config.pipelineName      Screwdriver pipeline name
     * @param {String} [config.projectKey]      Sonar project key. Rejected with a 403 if it does not name a
     *                                          project the calling build is authorized for (its own pipeline,
     *                                          its own job, or its PR parent job), or if it does not match
     *                                          the build's own configured coverage scope.
     * @param {String} [config.projectName]     Ignored; retained for backward compatibility. Always derived,
     *                                          never taken from the caller. Included in the mismatch warning
     *                                          message when username mismatches, but does not itself trigger
     *                                          that warning (pipelineName, its derivation source, is
     *                                          unavailable to legacy callers on every request).
     * @param {String} [config.username]        Ignored; retained for backward compatibility and mismatch
     *                                          logging only. Always derived from the project key.
     * @return {Promise}                        An access token that build can use
     *                                          to talk to coverage server
     */
    _getAccessToken({ scope, username, projectKey, projectName, jobName, pipelineName, buildCredentials }) {
        const { jobId, pipelineId, prParentJobId, scmContext } = buildCredentials;
        const authorizedProjectKeys = this.getAuthorizedProjectKeys({ jobId, pipelineId, prParentJobId });

        // A build may only ever request a token for its own pipeline or job.
        if (projectKey && !authorizedProjectKeys.includes(String(projectKey))) {
            logger.error(
                `Rejected coverage token request for project ${projectKey} from build in pipeline ${pipelineId} / ` +
                    `job ${jobId}; authorized: ${authorizedProjectKeys.join(', ')}`
            );

            return Promise.reject(
                boom.forbidden(`Not authorized to request a coverage token for project ${projectKey}`)
            );
        }

        // An authorized key is only trusted when it also matches the build's own configured coverage
        // scope - otherwise a build could use an authorized key for the *other* scope (its own pipeline and
        // its own job are both always "authorized") to cross from job to pipeline scope or back. Reject
        // outright rather than silently re-deriving: a silent mismatch would mint a token for one project
        // while the scanner uploads to another, and commands.txt runs the scanner under `|| true`, so that
        // failure would never surface.
        const coverageScope = this._resolveCoverageScope({ scope, enterpriseEnabled: this.sonarEnterprise });

        if (projectKey && projectKey.split(':')[0] !== coverageScope) {
            logger.error(
                `Rejected coverage token request for project ${projectKey} from build in pipeline ${pipelineId} / ` +
                    `job ${jobId}; does not match this build's coverage scope: ${coverageScope}`
            );

            return Promise.reject(
                boom.forbidden(`Project ${projectKey} does not match coverage scope ${coverageScope} for this build`)
            );
        }

        // projectName and username are never trusted here, even when projectKey is: every Sonar call below
        // runs with the instance-wide admin token, so a caller-supplied projectName would let a build point
        // another project's Git App binding at an arbitrary repository, and a caller-supplied username would
        // let a build mint a token for an arbitrary Sonar account. Both are always derived instead.
        const projectData = this.getProjectData({
            enterpriseEnabled: this.sonarEnterprise,
            jobId,
            jobName,
            prParentJobId,
            pipelineId,
            pipelineName,
            scope,
            projectKey
        });

        if (username && username !== projectData.username) {
            logger.warn(
                `Coverage token request for build in pipeline ${pipelineId} / job ${jobId} supplied ` +
                    `username=${JSON.stringify(username)}, projectName=${JSON.stringify(projectName)}, but ` +
                    `derived username=${JSON.stringify(projectData.username)} instead; using the derived value`
            );
        }

        const password = uuidv4();

        return this.createProject(projectData.projectKey)
            .then(() => this.configureGitApp(projectData.projectKey, projectData.projectName, scmContext))
            .then(() => this.createUser(projectData.username, password))
            .then(() => this.grantUserPermission(projectData.username, projectData.projectKey))
            .then(() => this.generateToken(projectData.username))
            .then(res => res.body.token);
    }

    /**
     * Return links to the Sonar project and coverage metadata
     * @method getInfo
     * @param   {Object}  config
     * @param   {Object}  [config.scope]            Coverage scope
     * @param   {String}  config.jobId              Screwdriver job ID
     * @param   {String}  config.jobName            Screwdriver job name
     * @param   {String}  config.pipelineId         Screwdriver pipeline ID (if enterprise is enabled)
     * @param   {String}  config.pipelineName       Screwdriver pipeline name
     * @param   {String}  [config.prNum]            Pull request number
     * @param   {String}  [config.prParentJobId]    Pull request parent job ID
     * @param   {String}  config.startTime          Job start time
     * @param   {String}  config.endTime            Job end time
     * @param   {String}  [config.projectKey]       Sonar project key
     * @return  {Promise}                           An object with:
     *                                              - tests success percentage
     *                                              - coverage percentage
     *                                              - project url
     *                                              - Sonar env vars
     */
    _getInfo({
        scope,
        jobId,
        jobName,
        startTime,
        endTime,
        pipelineId,
        pipelineName,
        prNum,
        projectKey: coverageProjectKey,
        prParentJobId
    }) {
        const { projectScope, projectKey, projectName, username } = this.getProjectData({
            enterpriseEnabled: this.sonarEnterprise,
            jobId,
            pipelineId,
            scope,
            pipelineName,
            jobName,
            projectKey: coverageProjectKey,
            prParentJobId
        });

        const infoObject = {
            envVars: {
                SD_SONAR_AUTH_URL: `${this.sdCoverageAuthUrl}?projectKey=${projectKey}&projectName=${projectName}&username=${username}&scope=${projectScope}`,
                SD_SONAR_HOST: this.sonarHost,
                SD_SONAR_ENTERPRISE: this.sonarEnterprise,
                SD_SONAR_PROJECT_KEY: projectKey,
                SD_SONAR_PROJECT_NAME: projectName
            }
        };

        // Only get coverage percentage if the steps are finished
        if (projectKey && startTime && endTime) {
            const { sonarEnterprise } = this;

            return this.getMetrics({ projectKey, startTime, endTime, prNum, sonarEnterprise }).then(
                ({ coverage, tests }) => {
                    const componentId = encodeURIComponent(projectKey);
                    let projectUrl = `${this.sonarHost}/dashboard?id=${componentId}`;

                    if (sonarEnterprise && prNum) {
                        projectUrl = projectUrl.concat(`&pullRequest=${prNum}`);
                    }

                    infoObject.coverage = coverage;
                    infoObject.tests = tests;
                    infoObject.projectUrl = projectUrl;

                    return Promise.resolve(infoObject);
                }
            );
        }

        return Promise.resolve(infoObject);
    }

    /**
     * Get shell command to upload coverage to server
     * @method _getUploadCoverageCmd
     * @return {Promise}     Shell commands to upload coverage
     */
    _getUploadCoverageCmd() {
        return Promise.resolve(this.uploadCommands.join(' && '));
    }
}

module.exports = CoverageSonar;
