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
        it('it constructs upload coverage command correctly', () => {
            const commandsPath = path.resolve(__dirname, './data/commands.txt');
            const commands = fs.readFileSync(commandsPath, 'utf8').replace('\n', '');

            return sonarPlugin.getUploadCoverageCmd().then(result =>
                assert.deepEqual(result, commands)
            );
        });
    });

    describe('getAccessToken', () => {
        const buildCredentials = { jobId: 1 };

        it('it gets an access token successfully', () => {
            requestMock.onCall(3).resolves({ token: 'accesstoken' });

            return sonarPlugin.getAccessToken(buildCredentials).then((result) => {
                assert.callCount(requestMock, 4);
                assert.strictEqual(result, 'accesstoken');
            });
        });

        it('it gets an access token successfully with existing pipeline', () => {
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

        it('it gets an access token successfully with existing user', () => {
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

        it('it throws err if failed to create/locate projects', () => {
            requestMock.onCall(0).rejects({
                statusCode: 500,
                message: 'internal server error'
            });

            return sonarPlugin.getAccessToken(buildCredentials).then(() => {
                assert.throws(new Error('should not get here'));
            }).catch(err => assert.deepEqual(err.statusCode, 500));
        });

        it('it throws err if failed to create/locate user', () => {
            requestMock.onCall(1).rejects({
                statusCode: 500,
                message: 'internal server error'
            });

            return sonarPlugin.getAccessToken(buildCredentials).then(() => {
                assert.throws(new Error('should not get here'));
            }).catch(err => assert.deepEqual(err.statusCode, 500));
        });
    });
});
