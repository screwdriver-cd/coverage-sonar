/* eslint no-underscore-dangle: ["error", { "allowAfterThis": true }] */

'use strict';

const fs = require('fs');
const joi = require('joi');
const path = require('path');
const request = require('request-promise-native');
const uuidv4 = require('uuid/v4');
const CoverageBase = require('screwdriver-coverage-base');

const COMMANDS = fs.readFileSync(path.join(__dirname, 'commands.txt'), 'utf8').trim();

let adminToken;
let sonarHost;
let sdApiAuthUrl;

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
        uri: `${sonarHost}/api/projects/create?project=${projectKey}&visibility=private`,
        auth: {
            username: adminToken
        }
    }).catch((err) => {
        if (err.statusCode === 400 && err.message.includes('already exists')) {
            return {};
        }

        throw err;
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
        uri: `${sonarHost}/api/users/create?login=${username}&name=${username}&password=${password}&password_confirmation=${password}`,
        auth: {
            username: adminToken
        }
    }).catch((err) => {
        if (err.statusCode === 400 && err.message.includes('already exists')) {
            return {};
        }

        throw err;
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
    });
}

/**
 * Generate an access token for the given user
 * @method generateToken
 * @param  {String} username   username of the user
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
    });
}

class CoverageSonar extends CoverageBase {
    /**
     * Constructor
     * @method constructor
     * @param  {Object} config              Configuration object
     * @param  {String} config.sdApiUrl     URL for Screwdriver API
     * @param  {String} config.sonarHost    Host for SonarQube Server
     * @param  {String} config.adminToken   Sonar Admin token
     */
    constructor(config) {
        super();

        this.config = joi.attempt(config, joi.object().keys({
            sdApiUrl: joi.string().uri().required(),
            sonarHost: joi.string().uri().required(),
            adminToken: joi.string().required()
        }).unknown(true), 'Invalid config for sonar coverage plugin');

        sdApiAuthUrl = `${this.config.sdApiUrl}/v4/coverage/token`;
        adminToken = this.config.adminToken;
        sonarHost = this.config.sonarHost;
        this.uploadCommands = COMMANDS
            .replace('$SD_API_AUTH_URL', sdApiAuthUrl)
            .replace('$SONAR_HOST', sonarHost)
            .split('\n');
        this.uploadCommands[this.uploadCommands.length - 1] += ' || true';
    }

    /**
     * Return an access token that build can use to talk to coverage server
     * @method getAccessToken
     * @param {Object} buildCredentials    Infomation stored in a build JWT
     * @return {Promise}                   An access token that build can use to talk to coverage server
     */
    _getAccessToken(buildCredentails) {
        const { jobId } = buildCredentails;
        const projectKey = `job:${jobId}`;
        const username = projectKey;
        const password = uuidv4();

        return createProject(projectKey)
            .then(() => createUser(username, password))
            .then(() => grantUserPermission(username, projectKey))
            .then(() => generateToken(username))
            .then(res => res.token);
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
