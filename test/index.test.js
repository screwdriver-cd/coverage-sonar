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
        sdUiUrl: 'https://cd.screwdriver.cd',
        sonarHost: 'https://sonar.screwdriver.cd',
        adminToken: 'faketoken'
    };
    const coverageObject = {
        paging: {
            pageIndex: 1,
            pageSize: 1,
            total: 4
        },
        measures: [
            {
                metric: 'tests',
                history: [
                    {
                        date: '2018-05-08T00:09:53+0000',
                        value: '10.0'
                    }
                ]
            },
            {
                metric: 'test_errors',
                history: [
                    {
                        date: '2018-05-08T00:09:53+0000',
                        value: '2.0'
                    }
                ]
            },
            {
                metric: 'test_failures',
                history: [
                    {
                        date: '2018-05-08T00:09:53+0000',
                        value: '1.0'
                    }
                ]
            },
            {
                metric: 'coverage',
                history: [
                    {
                        date: '2018-05-08T00:09:53+0000',
                        value: '98.8'
                    }
                ]
            }
        ]
    };
    let SonarPlugin;
    let sonarPlugin;
    let requestMock;
    let loggerMock;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        requestMock = sinon.stub().resolves(null);
        mockery.registerMock('request-promise-native', requestMock);

        loggerMock = {
            info: sinon.stub(),
            warn: sinon.stub(),
            error: sinon.stub()
        };
        mockery.registerMock('screwdriver-logger', loggerMock);

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
        it('constructs with defaults', () => {
            assert.ok(sonarPlugin);
            assert.property(sonarPlugin, 'getAccessToken');
            assert.property(sonarPlugin, 'getUploadCoverageCmd');
            assert.deepEqual(sonarPlugin.config, {
                { sonarEnterprise: false },
                ...config
            });
        });

        it('constructs', () => {
            assert.ok(sonarPlugin);
            assert.property(sonarPlugin, 'getAccessToken');
            assert.property(sonarPlugin, 'getUploadCoverageCmd');
            assert.deepEqual(sonarPlugin.config, {
                { sonarEnterprise: false },
                ...config
            });
        });
    });

    describe('getUploadCoverageCmd', () => {
        it('constructs upload coverage command correctly', () => {
            const commandsPath = path.resolve(__dirname, './data/commands.txt');
            const commands = fs.readFileSync(commandsPath, 'utf8').replace('\n', '');

            return sonarPlugin.getUploadCoverageCmd({ build: {} }).then(result =>
                assert.deepEqual(result, commands)
            );
        });
    });

    describe('getInfo', () => {
        it('returns links', () => {
            requestMock.onCall(0).resolves(coverageObject);
            const timezoneOffset = encodeURIComponent(new Date().toString().match(/GMT(.*?) /)[1]);

            return sonarPlugin.getInfo({
                buildId: '123',
                jobId: '1',
                startTime: '2017-10-19T13:00:00.123Z',
                endTime: '2017-10-19T15:00:00.234Z'
            }).then((result) => {
                assert.call(requestMock, sinon.match({ uri:
                    // eslint-disable-next-line max-len
                    `https://sonar.screwdriver.cd/api/measures/search_history?component=job%3A1&metrics=tests,test_errors,test_failures,coverage&from=2017-10-19T13%3A00%3A00${timezoneOffset}&to=2017-10-19T15%3A00%3A00${timezoneOffset}&ps=1` }));
                assert.deepEqual(result, {
                    coverage: '98.8',
                    tests: '7/10',
                    projectUrl: `${config.sonarHost}/dashboard?id=job%3A1`,
                    envVars: {
                        SD_SONAR_AUTH_URL: 'https://api.screwdriver.cd/v4/coverage/token',
                        SD_SONAR_HOST: 'https://sonar.screwdriver.cd'
                    }
                });
            });
        });

        it('returns links when startTime and endTime are not passed in', () => {
            requestMock.onCall(0).resolves(coverageObject);

            return sonarPlugin.getInfo({
                jobId: '1'
            }).then((result) => {
                assert.deepEqual(result, {
                    envVars: {
                        SD_SONAR_AUTH_URL: 'https://api.screwdriver.cd/v4/coverage/token',
                        SD_SONAR_HOST: 'https://sonar.screwdriver.cd'
                    }
                });
            });
        });

        it('return N/A if it fails to get coverage and tests', () => {
            requestMock.onCall(0).rejects({
                statusCode: 500,
                message: '500 - internal server error'
            });

            return sonarPlugin.getInfo({
                buildId: '123',
                jobId: '1',
                startTime: '2017-10-19T13:00:00.123Z',
                endTime: '2017-10-19T15:00:00.234Z'
            }).then((result) => {
                assert.callCount(loggerMock.error, 1);
                assert.deepEqual(result, {
                    coverage: 'N/A',
                    tests: 'N/A',
                    projectUrl: `${config.sonarHost}/dashboard?id=job%3A1`,
                    envVars: {
                        SD_SONAR_AUTH_URL: 'https://api.screwdriver.cd/v4/coverage/token',
                        SD_SONAR_HOST: 'https://sonar.screwdriver.cd'
                    }
                });
            });
        });

        it('return N/A if coverage and tests does not exists on sonar', () => {
            requestMock.onCall(0).rejects({
                statusCode: 404,
                message: '404 - {"errors":[{"msg":"Component key \'job:1\' not found"}]}'
            });

            return sonarPlugin.getInfo({
                buildId: '123',
                jobId: '1',
                startTime: '2017-10-19T13:00:00.123Z',
                endTime: '2017-10-19T15:00:00.234Z'
            }).then((result) => {
                assert.notCalled(loggerMock.error);
                assert.deepEqual(result, {
                    coverage: 'N/A',
                    tests: 'N/A',
                    projectUrl: `${config.sonarHost}/dashboard?id=job%3A1`,
                    envVars: {
                        SD_SONAR_AUTH_URL: 'https://api.screwdriver.cd/v4/coverage/token',
                        SD_SONAR_HOST: 'https://sonar.screwdriver.cd'
                    }
                });
            });
        });

        it('return N/A if the error message is an unexpected 404 error', () => {
            requestMock.onCall(0).rejects({
                statusCode: 404,
                message: '404 - Not Found'
            });

            return sonarPlugin.getInfo({
                buildId: '123',
                jobId: '1',
                startTime: '2017-10-19T13:00:00.123Z',
                endTime: '2017-10-19T15:00:00.234Z'
            }).then((result) => {
                assert.callCount(loggerMock.error, 1);
                assert.deepEqual(result, {
                    coverage: 'N/A',
                    tests: 'N/A',
                    projectUrl: `${config.sonarHost}/dashboard?id=job%3A1`,
                    envVars: {
                        SD_SONAR_AUTH_URL: 'https://api.screwdriver.cd/v4/coverage/token',
                        SD_SONAR_HOST: 'https://sonar.screwdriver.cd'
                    }
                });
            });
        });

        it('return N/A for tests if it tests metric does not exist', () => {
            const obj = JSON.parse(JSON.stringify(coverageObject));

            delete obj.measures[0];
            requestMock.onCall(0).resolves(obj);

            return sonarPlugin.getInfo({
                buildId: '123',
                jobId: '1',
                startTime: '2017-10-19T13:00:00.123Z',
                endTime: '2017-10-19T15:00:00.234Z'
            }).then(result => assert.deepEqual(result, {
                coverage: '98.8',
                tests: 'N/A',
                projectUrl: `${config.sonarHost}/dashboard?id=job%3A1`,
                envVars: {
                    SD_SONAR_AUTH_URL: 'https://api.screwdriver.cd/v4/coverage/token',
                    SD_SONAR_HOST: 'https://sonar.screwdriver.cd'
                }
            }));
        });

        it('return N/A for tests if it tests metric history value is not a number', () => {
            const obj = JSON.parse(JSON.stringify(coverageObject));

            obj.measures[0].history[0].value = 'unknown';
            requestMock.onCall(0).resolves(obj);

            return sonarPlugin.getInfo({
                buildId: '123',
                jobId: '1',
                startTime: '2017-10-19T13:00:00.123Z',
                endTime: '2017-10-19T15:00:00.234Z'
            }).then(result => assert.deepEqual(result, {
                coverage: '98.8',
                tests: 'N/A',
                projectUrl: `${config.sonarHost}/dashboard?id=job%3A1`,
                envVars: {
                    SD_SONAR_AUTH_URL: 'https://api.screwdriver.cd/v4/coverage/token',
                    SD_SONAR_HOST: 'https://sonar.screwdriver.cd'
                }
            }));
        });

        it('computes correct result if tests_errors metric is missing', () => {
            const obj = JSON.parse(JSON.stringify(coverageObject));

            delete obj.measures[1].history[0].value;
            requestMock.onCall(0).resolves(obj);

            return sonarPlugin.getInfo({
                buildId: '123',
                jobId: '1',
                startTime: '2017-10-19T13:00:00.123Z',
                endTime: '2017-10-19T15:00:00.234Z'
            }).then(result => assert.deepEqual(result, {
                coverage: '98.8',
                tests: '9/10',
                projectUrl: `${config.sonarHost}/dashboard?id=job%3A1`,
                envVars: {
                    SD_SONAR_AUTH_URL: 'https://api.screwdriver.cd/v4/coverage/token',
                    SD_SONAR_HOST: 'https://sonar.screwdriver.cd'
                }
            }));
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
