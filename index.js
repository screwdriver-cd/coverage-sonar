/* eslint no-underscore-dangle: ["error", { "allowAfterThis": true }] */

'use strict';

const fs = require('fs');
const joi = require('joi');
const hoek = require('@hapi/hoek');
const path = require('path');
const request = require('screwdriver-request');
const uuidv4 = require('uuid/v4');
const logger = require('screwdriver-logger');
const CoverageBase = require('screwdriver-coverage-base');

const COMMANDS = fs.readFileSync(path.join(__dirname, 'commands.txt'), 'utf8').trim();
const DEFAULT_GIT_APP_NAME = 'Screwdriver Sonar PR Checks';

let adminToken;
let sonarHost;
let sdCoverageAuthUrl;
let sonarEnterprise;
let sonarGitAppName;

/**
 * Create a project in sonar
 * @method createProject
 * @param  {String} projectKey    Unique identifier for the project
 * @return {Promise}              Project object if it gets created or empty object if already exists
 */
function createProject(projectKey) {
    return request({
        method: 'POST',
        url: `${sonarHost}/api/projects/create?project=${projectKey}&name=${projectKey}`,
        username: adminToken,
        context: {
            caller: 'createProject'
        }
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
function createUser(username, password) {
    return request({
        method: 'POST',
        url: `${sonarHost}/api/users/create?login=${username}&name=${username}&password=${password}`,
        username: adminToken,
        context: {
            caller: 'createUser'
        }
    }).catch(err => {
        if (err.statusCode === 400 && err.message.includes('already exists')) {
            return {};
        }

        throw new Error(`Failed to create user ${username}: ${err.message}`);
    });
}

/**
 * Configure Git App in SonarQube
 * @param  {String} projectKey  Sonar project key
 * @param  {String} projectName Sonar project name
 * @return {Promise}            Nothing if Git App configured successfully
 */
function configureGitApp(projectKey, projectName) {
    const gitApp = sonarGitAppName;
    const gitAppEncoded = encodeURIComponent(gitApp);
    const componentId = encodeURIComponent(projectKey);

    // Check if binding exists
    return request({
        method: 'GET',
        url: `${sonarHost}/api/alm_settings/get_binding?project=${componentId}`,
        username: adminToken,
        context: {
            caller: 'configureGitApp'
        }
    }).catch(() => {
        // if binding does not exist, add it
        logger.info(`Binding does not exist for Sonar project ${projectKey}, adding`);

        if (!sonarEnterprise || !projectName) {
            return Promise.resolve();
        }

        const parameters = `almSetting=${gitAppEncoded}&project=${componentId}&repository=${projectName}&summaryCommentEnabled=true`;

        return request({
            method: 'POST',
            url: `${sonarHost}/api/alm_settings/set_github_binding?${parameters}`,
            username: adminToken,
            context: {
                caller: 'configureGitApp'
            }
        }).catch(error => {
            // if cannot configure app, do not throw err
            logger.error(`Failed to configure Git App ${gitApp} for Sonar project ${projectKey}: ${error.message}`);

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
function grantUserPermission(username, projectKey) {
    // Always return 204 even with duplicate calls
    return request({
        method: 'POST',
        url: `${sonarHost}/api/permissions/add_user?login=${username}&permission=scan&projectKey=${projectKey}`,
        username: adminToken,
        context: {
            caller: 'grantUserPermission'
        }
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
function generateToken(username) {
    const tokenName = uuidv4();

    return request({
        method: 'POST',
        url: `${sonarHost}/api/user_tokens/generate?login=${username}&name=${tokenName}`,
        username: adminToken,
        context: {
            caller: 'generateToken'
        }
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
function getMetrics({ projectKey, startTime, endTime, prNum, sonarEnterprise: enterpriseEnabled }) {
    const componentId = encodeURIComponent(projectKey);
    // get timezone offset (e.g. -0700) from 'Fri May 11 2018 15:25:37 GMT-0700 (PDT)'
    const timezoneOffset = new Date().toString().match(/GMT(.*?) /)[1];
    // Convert the time format from 2018-05-10T19:05:53.123Z to 2018-05-10T19:05:53-0700 as required by sonar
    const parsedStartTime = startTime.replace(/\.(.*)/, timezoneOffset);
    const parsedEndTime = endTime.replace(/\.(.*)/, timezoneOffset);
    const from = encodeURIComponent(parsedStartTime);
    const to = encodeURIComponent(parsedEndTime);
    let coverageUrl = `${sonarHost}/api/measures/search_history?component=${componentId}&metrics=tests,test_errors,test_failures,coverage&from=${from}&to=${to}&ps=1`;

    if (enterpriseEnabled && prNum) {
        coverageUrl = coverageUrl.concat(`&pullRequest=${prNum}`);
    }

    return request({
        method: 'GET',
        url: coverageUrl,
        username: adminToken,
        context: {
            caller: 'getMetrics'
        }
    })
        .then(result => {
            const measures = {};

            // measures in result is an array, covert it to an object with metric name as key
            (hoek.reach(result, 'measures') || []).forEach(measure => {
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
function getProjectData({
    scope,
    enterpriseEnabled,
    jobId: buildJobId,
    jobName: buildJobName,
    pipelineId,
    pipelineName,
    projectKey,
    prParentJobId,
    prNum
}) {
    let jobId = buildJobId;
    let jobName = buildJobName;

    // Determine scope based on projectKey
    if (projectKey) {
        const [projectScope, id] = projectKey.split(':');
        const projectName = projectScope === 'pipeline' ? pipelineName : `${pipelineName}:${jobName}`;
        const username = `user-${projectScope}-${id}`;

        return {
            projectKey,
            username,
            projectName,
            projectScope
        };
    }

    // Use user-configured scope; otherwise figure out default scope: pipeline scope for enterprise edition, job scope for everything else
    const userScope = scope && scope !== 'undefined' ? scope : undefined;
    const coverageScope = userScope || (enterpriseEnabled ? 'pipeline' : 'job');

    if (coverageScope === 'pipeline') {
        return {
            projectKey: `pipeline:${pipelineId}`,
            projectName: pipelineName,
            username: `user-pipeline-${pipelineId}`,
            projectScope: coverageScope
        };
    }

    // Use prParentJobId as ID for PRs
    if (prNum && coverageScope === 'job' && enterpriseEnabled) {
        const prRegex = /^PR-(\d+)(?::([\w-]+))?$/;
        const prNameMatch = jobName.match(prRegex);

        jobId = prParentJobId;
        jobName = prNameMatch && prNameMatch.length > 1 ? prNameMatch[2] : jobName;
    }

    return {
        projectKey: `job:${jobId}`,
        projectName: `${pipelineName}:${jobName}`,
        username: `user-job-${jobId}`,
        projectScope: coverageScope
    };
}

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
                    sdApiUrl: joi
                        .string()
                        .uri()
                        .required(),
                    sdUiUrl: joi
                        .string()
                        .uri()
                        .required(),
                    sonarHost: joi
                        .string()
                        .uri()
                        .required(),
                    adminToken: joi.string().required(),
                    sonarEnterprise: joi.boolean().default(false),
                    sonarGitAppName: joi.string().default(DEFAULT_GIT_APP_NAME)
                })
                .unknown(true),
            'Invalid config for sonar coverage plugin'
        );

        sdCoverageAuthUrl = `${this.config.sdApiUrl}/v4/coverage/token`;
        adminToken = this.config.adminToken;
        sonarHost = this.config.sonarHost;
        sonarEnterprise = this.config.sonarEnterprise;
        sonarGitAppName = this.config.sonarGitAppName;

        this.uploadCommands = COMMANDS.replace('$SD_SONAR_HOST', sonarHost)
            .replace('$SD_UI_URL', this.config.sdUiUrl)
            .replace('$SD_SONAR_ENTERPRISE', sonarEnterprise)
            .split('\n');

        this.uploadCommands[this.uploadCommands.length - 1] += ' || true';
    }

    /**
     * Return an access token that build can use to talk to coverage server
     * @method getAccessToken
     * @param {Object} config
     * @param {String} [config.scope]           Coverage scope
     * @param {Object} config.buildCredentials  Information stored in a build JWT
     * @param {String} [config.jobName]         Screwdriver job name
     * @param {String} config.pipelineName      Screwdriver pipeline name
     * @param {String} [config.projectKey]      Sonar project key
     * @param {String} [config.projectName]     Sonar project name
     * @param {String} [config.username]        Sonar username
     * @return {Promise}                        An access token that build can use
     *                                          to talk to coverage server
     */
    _getAccessToken({ scope, username, projectKey, projectName, jobName, pipelineName, buildCredentials }) {
        const { jobId, pipelineId, prParentJobId } = buildCredentials;
        let projectData = { username, projectKey, projectName };

        if (!username || !projectKey || !projectName || projectName.includes('undefined')) {
            projectData = getProjectData({
                enterpriseEnabled: sonarEnterprise,
                jobId,
                jobName,
                prParentJobId,
                pipelineId,
                pipelineName,
                scope,
                projectKey
            });
        }

        const password = uuidv4();

        return createProject(projectData.projectKey)
            .then(() => configureGitApp(projectData.projectKey, projectData.projectName))
            .then(() => createUser(projectData.username, password))
            .then(() => grantUserPermission(projectData.username, projectData.projectKey))
            .then(() => generateToken(projectData.username))
            .then(res => res.token);
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
        const { projectScope, projectKey, projectName, username } = getProjectData({
            enterpriseEnabled: sonarEnterprise,
            jobId,
            pipelineId,
            scope,
            pipelineName,
            jobName,
            projectKey: coverageProjectKey,
            prParentJobId,
            prNum
        });

        const infoObject = {
            envVars: {
                SD_SONAR_AUTH_URL: `${sdCoverageAuthUrl}?projectKey=${projectKey}&projectName=${projectName}&username=${username}&scope=${projectScope}`,
                SD_SONAR_HOST: sonarHost,
                SD_SONAR_ENTERPRISE: sonarEnterprise,
                SD_SONAR_PROJECT_KEY: projectKey,
                SD_SONAR_PROJECT_NAME: projectName
            }
        };

        // Only get coverage percentage if the steps are finished
        if (projectKey && startTime && endTime) {
            return getMetrics({ projectKey, startTime, endTime, prNum, sonarEnterprise }).then(
                ({ coverage, tests }) => {
                    const componentId = encodeURIComponent(projectKey);
                    let projectUrl = `${this.config.sonarHost}/dashboard?id=${componentId}`;

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
