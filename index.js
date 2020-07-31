/* eslint no-underscore-dangle: ["error", { "allowAfterThis": true }] */

'use strict';

const fs = require('fs');
const joi = require('joi');
const hoek = require('hoek');
const path = require('path');
const request = require('request-promise-native');
const uuidv4 = require('uuid/v4');
const logger = require('screwdriver-logger');
const CoverageBase = require('screwdriver-coverage-base');

const COMMANDS = fs.readFileSync(path.join(__dirname, 'commands.txt'), 'utf8').trim();
const COVERAGE_SCOPE_ANNOTATION = 'screwdriver.cd/coverageScope';

let adminToken;
let sonarHost;
let sdCoverageAuthUrl;
let sonarEnterprise;

/**
 * Create a project in sonar
 * @method createProject
 * @param  {String} projectKey    Unique identifier for the project
 * @return {Promise}              Project object if it gets created or empty object if already exists
 */
function createProject(projectKey) {
    return request({
        json: true,
        method: 'POST',
        // eslint-disable-next-line max-len
        uri: `${sonarHost}/api/projects/create?project=${projectKey}&name=${projectKey}`,
        auth: {
            username: adminToken
        }
    }).catch((err) => {
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
        json: true,
        method: 'POST',
        // eslint-disable-next-line max-len
        uri: `${sonarHost}/api/users/create?login=${username}&name=${username}&password=${password}`,
        auth: {
            username: adminToken
        }
    }).catch((err) => {
        if (err.statusCode === 400 && err.message.includes('already exists')) {
            return {};
        }

        throw new Error(`Failed to create user ${username}: ${err.message}`);
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
        json: true,
        method: 'POST',
        // eslint-disable-next-line
        uri: `${sonarHost}/api/permissions/add_user?login=${username}&permission=scan&projectKey=${projectKey}`,
        auth: {
            username: adminToken
        }
    }).catch((err) => {
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
        json: true,
        method: 'POST',
        uri: `${sonarHost}/api/user_tokens/generate?login=${username}&name=${tokenName}`,
        auth: {
            username: adminToken
        }
    }).catch((err) => {
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
function getMetrics({ projectKey, startTime, endTime, prNum }) {
    const componentId = encodeURIComponent(projectKey);
    // get timezone offset (e.g. -0700) from 'Fri May 11 2018 15:25:37 GMT-0700 (PDT)'
    const timezoneOffset = new Date().toString().match(/GMT(.*?) /)[1];
    // Convert the time format from 2018-05-10T19:05:53.123Z to 2018-05-10T19:05:53-0700 as required by sonar
    const parsedStartTime = startTime.replace(/\.(.*)/, timezoneOffset);
    const parsedEndTime = endTime.replace(/\.(.*)/, timezoneOffset);
    const from = encodeURIComponent(parsedStartTime);
    const to = encodeURIComponent(parsedEndTime);
    // eslint-disable-next-line max-len
    let coverageUrl = `${sonarHost}/api/measures/search_history?component=${componentId}&metrics=tests,test_errors,test_failures,coverage&from=${from}&to=${to}&ps=1`;

    if (projectKey.startsWith('pipeline') && prNum) {
        coverageUrl = coverageUrl.concat(`&pullRequest=${prNum}`);
    }

    return request({
        json: true,
        method: 'GET',
        uri: coverageUrl,
        auth: {
            username: adminToken
        }
    })
        .then((result) => {
            const measures = {};

            // measures in result is an array, covert it to an object with metric name as key
            (hoek.reach(result, 'measures') || []).forEach((measure) => {
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
        .catch((err) => {
            // if there is no coverage measurement target, 404 and 'Component key not found' are returned and this is not an error
            if (err.statusCode !== 404 || !/Component key '.*' not found/.test(err.message)) {
                // if cannot get coverage, do not throw err
                // eslint-disable-next-line max-len
                logger.error(`Failed to get coverage and tests percentage for Sonar project ${projectKey}: ${err.message}`);
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
 * @param  {Object}     [config.annotations]        Screwdriver job annotations
 * @param  {Boolean}    config.enterpriseEnabled    If enterprise is enabled
 * @param  {String}     config.jobId                Screwdriver job ID
 * @param  {String}     config.jobName              Screwdriver job name
 * @param  {String}     config.pipelineId           Screwdriver pipeline ID
 * @param  {String}     config.pipelineName         Screwdriver pipeline name
 * @return {Object}                                 Sonar project key, project name, and username
 */
function getProjectData({ annotations, enterpriseEnabled, jobId, jobName, pipelineId,
    pipelineName }) {
    // Figure out default scope: pipeline scope for enterprise edition, job scope for everything else
    const defaultScope = enterpriseEnabled ? 'pipeline' : 'job';
    // Use user-configured scope or default scope
    const scope = (annotations && annotations[COVERAGE_SCOPE_ANNOTATION]) || defaultScope;

    if (scope === 'pipeline') {
        return {
            projectKey: `pipeline:${pipelineId}`,
            projectName: pipelineName,
            username: `user-pipeline-${pipelineId}`
        };
    }

    return {
        projectKey: `job:${jobId}`,
        projectName: `${pipelineName}:${jobName}`,
        username: `user-job-${jobId}`
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

        this.config = joi.attempt(config, joi.object().keys({
            sdApiUrl: joi.string().uri().required(),
            sdUiUrl: joi.string().uri().required(),
            sonarHost: joi.string().uri().required(),
            adminToken: joi.string().required(),
            sonarEnterprise: joi.boolean().default(false)
        }).unknown(true), 'Invalid config for sonar coverage plugin');

        sdCoverageAuthUrl = `${this.config.sdApiUrl}/v4/coverage/token`;
        adminToken = this.config.adminToken;
        sonarHost = this.config.sonarHost;
        sonarEnterprise = this.config.sonarEnterprise;
    }

    /**
     * Return an access token that build can use to talk to coverage server
     * @method getAccessToken
     * @param {Object} config
     * @param {Object} [config.annotations]     Screwdriver job annotations
     * @param {Object} config.buildCredentials  Information stored in a build JWT
     * @return {Promise}                        An access token that build can use
     *                                          to talk to coverage server
     */
    _getAccessToken({ annotations, buildCredentials }) {
        const { jobId, pipelineId, prParentJobId } = buildCredentials;
        const { projectKey, username } = getProjectData({
            enterpriseEnabled: sonarEnterprise,
            jobId: prParentJobId || jobId,
            pipelineId,
            annotations
        });
        const password = uuidv4();

        return createProject(projectKey)
            .then(() => createUser(username, password))
            .then(() => grantUserPermission(username, projectKey))
            .then(() => generateToken(username))
            .then(res => res.token);
    }

    /**
     * Return links to the Sonar project and coverage metadata
     * @method getInfo
     * @param   {Object}  config
     * @param   {Object}  [config.annotations]      Screwdriver job annotations
     * @param   {String}  config.jobId              Screwdriver job ID
     * @param   {String}  config.jobName            Screwdriver job name
     * @param   {String}  config.pipelineId         Screwdriver pipeline ID (if enterprise is enabled)
     * @param   {String}  config.pipelineName       Screwdriver pipeline name
     * @param   {String}  [config.prNum]            Pull request number
     * @param   {String}  [config.prParentJobId]    Pull request parent job ID
     * @param   {String}  config.startTime          Job start time
     * @param   {String}  config.endTime            Job end time
     * @param   {String}  [config.coverageProjectKey]  Sonar project key
     * @return  {Promise}                           An object with:
     *                                              - tests success percentage
     *                                              - coverage percentage
     *                                              - project url
     *                                              - Sonar env vars
     */
    _getInfo({ annotations, jobId, jobName, startTime, endTime, pipelineId,
        pipelineName, prNum, coverageProjectKey, prParentJobId }) {
        const { projectKey: computedProjectKey, projectName } = getProjectData({
            enterpriseEnabled: sonarEnterprise,
            jobId: prNum ? prParentJobId : jobId,
            pipelineId,
            annotations,
            pipelineName,
            jobName
        });
        const projectKey = coverageProjectKey || computedProjectKey;
        const infoObject = {
            envVars: {
                SD_SONAR_AUTH_URL: sdCoverageAuthUrl,
                SD_SONAR_HOST: sonarHost,
                SD_SONAR_ENTERPRISE: sonarEnterprise,
                SD_SONAR_PROJECT_KEY: projectKey,
                SD_SONAR_PROJECT_NAME: projectName
            }
        };

        // Only get coverage percentage if the steps are finished
        if (projectKey && startTime && endTime) {
            return getMetrics({ projectKey, startTime, endTime, prNum })
                .then(({ coverage, tests }) => {
                    const componentId = encodeURIComponent(projectKey);
                    const projectUrl = `${this.config.sonarHost}/dashboard?id=${componentId}`;

                    infoObject.coverage = coverage;
                    infoObject.tests = tests;
                    infoObject.projectUrl = projectUrl;

                    return Promise.resolve(infoObject);
                });
        }

        return Promise.resolve(infoObject);
    }

    /**
     * Get shell command to upload coverage to server
     * @method _getUploadCoverageCmd
     * @param  {Object}  config
     * @param  {Object}  [config.annotations]  Screwdriver job annotations
     * @param  {String}  config.jobId          Screwdriver job ID
     * @param  {String}  config.jobName        Screwdriver job name
     * @param  {String}  config.pipelineId     Screwdriver pipeline ID
     * @param  {String}  config.pipelineName   Screwdriver pipeline name
     * @return {Promise}     Shell commands to upload coverage
     */
    _getUploadCoverageCmd({ annotations, jobId, jobName, pipelineId, pipelineName }) {
        const { projectKey, projectName } = getProjectData({
            enterpriseEnabled: sonarEnterprise,
            jobId,
            pipelineId,
            annotations,
            pipelineName,
            jobName
        });
        const uploadCommands = COMMANDS
            .replace('$SD_SONAR_AUTH_URL', sdCoverageAuthUrl)
            .replace('$SD_SONAR_HOST', sonarHost)
            .replace('$SD_UI_URL', this.config.sdUiUrl)
            .replace('$SD_SONAR_ENTERPRISE', sonarEnterprise)
            .replace('$SD_SONAR_PROJECT_KEY', projectKey)
            .replace('$SD_SONAR_PROJECT_NAME', projectName)
            .split('\n');

        uploadCommands[uploadCommands.length - 1] += ' || true';

        return Promise.resolve(uploadCommands.join(' && '));
    }
}

module.exports = CoverageSonar;
