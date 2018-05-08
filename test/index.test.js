'use strict';

const assert = require('chai').assert;
const mockery = require('mockery');
const sinon = require('sinon');
const fs = require('fs');
const path = require('path');

sinon.assert.expose(assert, { prefix: '' });

describe('index test', () => {
    const config = {
        sdApiUrl: 'https://api.screwdriver.cd',
        sonarHost: 'https://sonar.screwdriver.cd',
        adminToken: 'faketoken'
    };
    let SonarPlugin;
    let sonarPlugin;
    let requestMock;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        requestMock = sinon.stub().resolves(null);
        mockery.registerMock('request-promise-native', requestMock);

        // eslint-disable-next-line global-require
        SonarPlugin = require('..');

        sonarPlugin = new SonarPlugin(config);
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
    });

    after(() => {
        mockery.disable();
    });

    describe('constructor', () => {
        it('constructs', () => {
            assert.ok(sonarPlugin);
            assert.property(sonarPlugin, 'getAccessToken');
            assert.property(sonarPlugin, 'getUploadCoverageCmd');
            assert.deepEqual(sonarPlugin.config, config);
        });
    });

    describe('getUploadCoverageCmd', () => {
        it('constructs upload coverage command correctly', () => {
            const commandsPath = path.resolve(__dirname, './data/commands.txt');
            const commands = fs.readFileSync(commandsPath, 'utf8').replace('\n', '');

            return sonarPlugin.getUploadCoverageCmd().then(result =>
                assert.deepEqual(result, commands)
            );
        });
    });

    describe('getLinks', () => {
        it('returns links', () => {
            sonarPlugin.getLinks('1').then(result =>
                assert.deepEqual(result, {
                    badge: `${config.sonarHost}/api/badges/measure?key=job%3A1&metric=coverage`,
                    project: `${config.sonarHost}/dashboard?id=job%3A1`
                })
            );
        });
    });

    describe('getAccessToken', () => {
        const buildCredentials = { jobId: 1 };

        it('gets an access token successfully', () => {
            requestMock.onCall(3).resolves({ token: 'accesstoken' });

            return sonarPlugin.getAccessToken(buildCredentials).then((result) => {
                assert.callCount(requestMock, 4);
                assert.strictEqual(result, 'accesstoken');
            });
        });

        it('gets an access token successfully with existing pipeline', () => {
            requestMock.onCall(0).rejects({
                statusCode: 400,
                message: 'Project already exists.'
            });
            requestMock.onCall(3).resolves({ token: 'accesstoken' });

            return sonarPlugin.getAccessToken(buildCredentials).then((result) => {
                assert.callCount(requestMock, 4);
                assert.strictEqual(result, 'accesstoken');
            });
        });

        it('gets an access token successfully with existing user', () => {
            requestMock.onCall(1).rejects({
                statusCode: 400,
                message: 'user already exists.'
            });
            requestMock.onCall(3).resolves({ token: 'accesstoken' });

            return sonarPlugin.getAccessToken(buildCredentials).then((result) => {
                assert.callCount(requestMock, 4);
                assert.strictEqual(result, 'accesstoken');
            });
        });

        it('throws err if failed to create/locate projects', () => {
            requestMock.onCall(0).rejects({
                statusCode: 500,
                message: '500 - internal server error'
            });

            return sonarPlugin.getAccessToken(buildCredentials).then(() => {
                assert.throws(new Error('should not get here'));
            }).catch(err => assert.deepEqual(err.message,
                'Failed to create project job:1: 500 - internal server error'));
        });

        it('throws err if failed to create/locate user', () => {
            requestMock.onCall(1).rejects({
                statusCode: 500,
                message: '500 - internal server error'
            });

            return sonarPlugin.getAccessToken(buildCredentials).then(() => {
                assert.throws(new Error('should not get here'));
            }).catch(err => assert.deepEqual(err.message,
                'Failed to create user user-job-1: 500 - internal server error'));
        });

        it('throws err if failed to grant user permission', () => {
            requestMock.onCall(2).rejects({
                statusCode: 500,
                message: '500 - internal server error'
            });

            return sonarPlugin.getAccessToken(buildCredentials).then(() => {
                assert.throws(new Error('should not get here'));
            }).catch(err => assert.deepEqual(err.message,
                'Failed to grant user user-job-1 permission: 500 - internal server error'));
        });

        it('it throws err if failed to generate user token', () => {
            requestMock.onCall(3).rejects({
                statusCode: 500,
                message: '500 - internal server error'
            });

            return sonarPlugin.getAccessToken(buildCredentials).then(() => {
                assert.throws(new Error('should not get here'));
            }).catch(err => assert.deepEqual(err.message,
                'Failed to generate user user-job-1 token: 500 - internal server error'));
        });
    });
});
