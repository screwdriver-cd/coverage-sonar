'use strict';

const { assert } = require('chai');
const mockery = require('mockery');
const sinon = require('sinon');
const fs = require('fs');
const path = require('path');

sinon.assert.expose(assert, { prefix: '' });

describe('index test', () => {
    let config;
    let enterpriseConfig;
    let coverageObject;
    let SonarPlugin;
    let sonarPlugin;
    let enterpriseSonarPlugin;
    let requestMock;
    let loggerMock;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        config = {
            sdApiUrl: 'https://api.screwdriver.cd',
            sdUiUrl: 'https://cd.screwdriver.cd',
            sonarHost: 'https://sonar.screwdriver.cd',
            adminToken: 'faketoken',
            sonarGitAppName: 'Screwdriver Sonar PR Checks'
        };
        enterpriseConfig = {
            sdApiUrl: 'https://api.screwdriver.cd',
            sdUiUrl: 'https://cd.screwdriver.cd',
            sonarHost: 'https://sonar.screwdriver.cd',
            adminToken: 'faketoken',
            sonarEnterprise: true,
            sonarGitAppName: 'Screwdriver Sonar PR Checks'
        };
        coverageObject = {
            body: {
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
            }
        };
        requestMock = sinon.stub().resolves(null);
        mockery.registerMock('screwdriver-request', requestMock);

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
            config.sonarEnterprise = false;

            assert.ok(sonarPlugin);
            assert.property(sonarPlugin, 'getAccessToken');
            assert.property(sonarPlugin, 'getInfo');
            assert.property(sonarPlugin, 'getUploadCoverageCmd');
            assert.deepEqual(sonarPlugin.config, config);
        });

        it('constructs enterprise Sonar', () => {
            enterpriseSonarPlugin = new SonarPlugin(enterpriseConfig);
            assert.ok(enterpriseSonarPlugin);
            assert.property(enterpriseSonarPlugin, 'getAccessToken');
            assert.property(sonarPlugin, 'getInfo');
            assert.property(enterpriseSonarPlugin, 'getUploadCoverageCmd');
            assert.deepEqual(enterpriseSonarPlugin.config, enterpriseConfig);
        });
    });

    describe('getUploadCoverageCmd', () => {
        it('constructs upload coverage command correctly', () => {
            const commandsPath = path.resolve(__dirname, './data/commands.txt');
            const commands = fs.readFileSync(commandsPath, 'utf8').replace('\n', '');

            return sonarPlugin
                .getUploadCoverageCmd({
                    build: {},
                    pipeline: { id: 123, name: 'd2lam/mytest' },
                    job: { id: 456, name: 'main', permutations: [{}] }
                })
                .then(result => assert.deepEqual(result, commands));
        });

        it('constructs upload coverage command correctly with annotations', () => {
            const commandsPath = path.resolve(__dirname, './data/commands_with_annotation.txt');
            const commands = fs.readFileSync(commandsPath, 'utf8').replace('\n', '');

            return sonarPlugin
                .getUploadCoverageCmd({
                    build: {},
                    pipeline: { id: 123, name: 'd2lam/mytest' },
                    job: {
                        id: 456,
                        name: 'main',
                        permutations: [
                            {
                                annotations: { 'screwdriver.cd/coverageScope': 'pipeline' }
                            }
                        ]
                    }
                })
                .then(result => assert.deepEqual(result, commands));
        });
    });

    describe('getInfo', () => {
        const sdSonarAuthUrl = 'https://api.screwdriver.cd/v4/coverage/token';
        const timezoneOffset = encodeURIComponent(new Date().toString().match(/GMT(.*?) /)[1]);
        const startTime = '2017-10-19T13:00:00.123Z';
        const endTime = '2017-10-19T15:00:00.234Z';

        beforeEach(() => {
            requestMock.onCall(0).resolves(coverageObject);
        });

        it('returns links', () =>
            sonarPlugin
                .getInfo({
                    pipelineId: '123',
                    jobId: '1',
                    startTime,
                    endTime,
                    jobName: 'main',
                    pipelineName: 'd2lam/mytest'
                })
                .then(result => {
                    assert.calledWith(
                        requestMock,
                        sinon.match({
                            url: `https://sonar.screwdriver.cd/api/measures/search_history?component=job%3A1&metrics=tests,test_errors,test_failures,coverage&from=2017-10-19T13%3A00%3A00${timezoneOffset}&to=2017-10-19T15%3A00%3A00${timezoneOffset}&ps=1`
                        })
                    );
                    assert.deepEqual(result, {
                        coverage: '98.8',
                        tests: '7/10',
                        projectUrl: `${config.sonarHost}/dashboard?id=job%3A1`,
                        envVars: {
                            SD_SONAR_AUTH_URL: `${sdSonarAuthUrl}?projectKey=job:1&projectName=d2lam/mytest:main&username=user-job-1&scope=job`,
                            SD_SONAR_HOST: 'https://sonar.screwdriver.cd',
                            SD_SONAR_ENTERPRISE: false,
                            SD_SONAR_PROJECT_KEY: 'job:1',
                            SD_SONAR_PROJECT_NAME: 'd2lam/mytest:main'
                        }
                    });
                    assert.callCount(requestMock, 1);
                }));

        it('returns links with pipeline scope annotation', () =>
            sonarPlugin
                .getInfo({
                    jobId: '1',
                    startTime,
                    endTime,
                    jobName: 'main',
                    pipelineId: 123,
                    pipelineName: 'd2lam/mytest',
                    scope: 'pipeline'
                })
                .then(result => {
                    assert.calledWith(
                        requestMock,
                        sinon.match({
                            url: `https://sonar.screwdriver.cd/api/measures/search_history?component=pipeline%3A123&metrics=tests,test_errors,test_failures,coverage&from=2017-10-19T13%3A00%3A00${timezoneOffset}&to=2017-10-19T15%3A00%3A00${timezoneOffset}&ps=1`
                        })
                    );
                    assert.deepEqual(result, {
                        coverage: '98.8',
                        tests: '7/10',
                        projectUrl: `${config.sonarHost}/dashboard?id=pipeline%3A123`,
                        envVars: {
                            SD_SONAR_AUTH_URL: `${sdSonarAuthUrl}?projectKey=pipeline:123&projectName=d2lam/mytest&username=user-pipeline-123&scope=pipeline`,
                            SD_SONAR_HOST: 'https://sonar.screwdriver.cd',
                            SD_SONAR_ENTERPRISE: false,
                            SD_SONAR_PROJECT_KEY: 'pipeline:123',
                            SD_SONAR_PROJECT_NAME: 'd2lam/mytest'
                        }
                    });
                    assert.callCount(requestMock, 1);
                }));

        // eslint-disable-next-line max-len
        it('returns links with only coverageProjectKey, startTime, and endTime passed in', () =>
            sonarPlugin
                .getInfo({
                    projectKey: 'pipeline:123',
                    pipelineName: 'd2lam/mytest',
                    startTime,
                    endTime
                })
                .then(result => {
                    assert.calledWith(
                        requestMock,
                        sinon.match({
                            url: `https://sonar.screwdriver.cd/api/measures/search_history?component=pipeline%3A123&metrics=tests,test_errors,test_failures,coverage&from=2017-10-19T13%3A00%3A00${timezoneOffset}&to=2017-10-19T15%3A00%3A00${timezoneOffset}&ps=1`
                        })
                    );
                    assert.deepEqual(result, {
                        coverage: '98.8',
                        tests: '7/10',
                        projectUrl: `${config.sonarHost}/dashboard?id=pipeline%3A123`,
                        envVars: {
                            SD_SONAR_AUTH_URL: `${sdSonarAuthUrl}?projectKey=pipeline:123&projectName=d2lam/mytest&username=user-pipeline-123&scope=pipeline`,
                            SD_SONAR_HOST: 'https://sonar.screwdriver.cd',
                            SD_SONAR_ENTERPRISE: false,
                            SD_SONAR_PROJECT_KEY: 'pipeline:123',
                            SD_SONAR_PROJECT_NAME: 'd2lam/mytest'
                        }
                    });
                    assert.callCount(requestMock, 1);
                }));

        it('returns links for enterprise', () => {
            requestMock.onCall(0).resolves(coverageObject);
            enterpriseSonarPlugin = new SonarPlugin(enterpriseConfig);

            return enterpriseSonarPlugin
                .getInfo({
                    jobId: '1',
                    startTime,
                    endTime,
                    pipelineId: 123,
                    prNum: null,
                    jobName: 'main',
                    pipelineName: 'd2lam/mytest'
                })
                .then(result => {
                    assert.calledWith(
                        requestMock,
                        sinon.match({
                            url: `https://sonar.screwdriver.cd/api/measures/search_history?component=pipeline%3A123&metrics=tests,test_errors,test_failures,coverage&from=2017-10-19T13%3A00%3A00${timezoneOffset}&to=2017-10-19T15%3A00%3A00${timezoneOffset}&ps=1`
                        })
                    );
                    assert.deepEqual(result, {
                        coverage: '98.8',
                        tests: '7/10',
                        projectUrl: `${config.sonarHost}/dashboard?id=pipeline%3A123`,
                        envVars: {
                            SD_SONAR_AUTH_URL: `${sdSonarAuthUrl}?projectKey=pipeline:123&projectName=d2lam/mytest&username=user-pipeline-123&scope=pipeline`,
                            SD_SONAR_HOST: 'https://sonar.screwdriver.cd',
                            SD_SONAR_ENTERPRISE: true,
                            SD_SONAR_PROJECT_KEY: 'pipeline:123',
                            SD_SONAR_PROJECT_NAME: 'd2lam/mytest'
                        }
                    });
                    assert.callCount(requestMock, 1);
                });
        });

        // eslint-disable-next-line max-len
        it('returns links for enterprise and does not throw err if cannot configure Git app', () => {
            requestMock.onCall(0).resolves(coverageObject);
            enterpriseSonarPlugin = new SonarPlugin(enterpriseConfig);

            return enterpriseSonarPlugin
                .getInfo({
                    jobId: '1',
                    startTime,
                    endTime,
                    pipelineId: 123,
                    prNum: null,
                    jobName: 'main',
                    pipelineName: 'd2lam/mytest'
                })
                .then(result => {
                    assert.calledWith(
                        requestMock,
                        sinon.match({
                            url: `https://sonar.screwdriver.cd/api/measures/search_history?component=pipeline%3A123&metrics=tests,test_errors,test_failures,coverage&from=2017-10-19T13%3A00%3A00${timezoneOffset}&to=2017-10-19T15%3A00%3A00${timezoneOffset}&ps=1`
                        })
                    );
                    assert.deepEqual(result, {
                        coverage: '98.8',
                        tests: '7/10',
                        projectUrl: `${config.sonarHost}/dashboard?id=pipeline%3A123`,
                        envVars: {
                            SD_SONAR_AUTH_URL: `${sdSonarAuthUrl}?projectKey=pipeline:123&projectName=d2lam/mytest&username=user-pipeline-123&scope=pipeline`,
                            SD_SONAR_HOST: 'https://sonar.screwdriver.cd',
                            SD_SONAR_ENTERPRISE: true,
                            SD_SONAR_PROJECT_KEY: 'pipeline:123',
                            SD_SONAR_PROJECT_NAME: 'd2lam/mytest'
                        }
                    });
                    assert.callCount(requestMock, 1);
                });
        });

        it('returns links for enterprise PR', () => {
            requestMock.onCall(0).resolves(coverageObject);
            enterpriseSonarPlugin = new SonarPlugin(enterpriseConfig);

            return enterpriseSonarPlugin
                .getInfo({
                    jobId: '1',
                    startTime,
                    endTime,
                    pipelineId: 123,
                    prNum: 56,
                    jobName: 'main',
                    pipelineName: 'd2lam/mytest',
                    prParentJobId: 456
                })
                .then(result => {
                    assert.calledWith(
                        requestMock,
                        sinon.match({
                            url: `https://sonar.screwdriver.cd/api/measures/search_history?component=pipeline%3A123&metrics=tests,test_errors,test_failures,coverage&from=2017-10-19T13%3A00%3A00${timezoneOffset}&to=2017-10-19T15%3A00%3A00${timezoneOffset}&ps=1&pullRequest=56`
                        })
                    );
                    assert.deepEqual(result, {
                        coverage: '98.8',
                        tests: '7/10',
                        projectUrl: `${config.sonarHost}/dashboard?id=pipeline%3A123&pullRequest=56`,
                        envVars: {
                            SD_SONAR_AUTH_URL: `${sdSonarAuthUrl}?projectKey=pipeline:123&projectName=d2lam/mytest&username=user-pipeline-123&scope=pipeline`,
                            SD_SONAR_HOST: 'https://sonar.screwdriver.cd',
                            SD_SONAR_ENTERPRISE: true,
                            SD_SONAR_PROJECT_KEY: 'pipeline:123',
                            SD_SONAR_PROJECT_NAME: 'd2lam/mytest'
                        }
                    });
                    assert.callCount(requestMock, 1);
                });
        });

        it('returns links for enterprise PR with job scope annotation', () => {
            requestMock.onCall(0).resolves(coverageObject);
            enterpriseSonarPlugin = new SonarPlugin(enterpriseConfig);
            const projectName = 'd2lam/mytest:main';

            return enterpriseSonarPlugin
                .getInfo({
                    jobId: '1',
                    startTime,
                    endTime,
                    pipelineId: 123,
                    prNum: 56,
                    jobName: 'main',
                    pipelineName: 'd2lam/mytest',
                    scope: 'job',
                    prParentJobId: 456
                })
                .then(result => {
                    assert.calledWith(
                        requestMock,
                        sinon.match({
                            url: `https://sonar.screwdriver.cd/api/measures/search_history?component=job%3A456&metrics=tests,test_errors,test_failures,coverage&from=2017-10-19T13%3A00%3A00${timezoneOffset}&to=2017-10-19T15%3A00%3A00${timezoneOffset}&ps=1&pullRequest=56`
                        })
                    );
                    assert.deepEqual(result, {
                        coverage: '98.8',
                        tests: '7/10',
                        projectUrl: `${config.sonarHost}/dashboard?id=job%3A456&pullRequest=56`,
                        envVars: {
                            SD_SONAR_AUTH_URL: `${sdSonarAuthUrl}?projectKey=job:456&projectName=d2lam/mytest:main&username=user-job-456&scope=job`,
                            SD_SONAR_HOST: 'https://sonar.screwdriver.cd',
                            SD_SONAR_ENTERPRISE: true,
                            SD_SONAR_PROJECT_KEY: 'job:456',
                            SD_SONAR_PROJECT_NAME: projectName
                        }
                    });
                    assert.callCount(requestMock, 1);
                });
        });

        it('returns links when startTime and endTime are not passed in', () =>
            sonarPlugin
                .getInfo({
                    jobId: '1',
                    jobName: 'main',
                    pipelineName: 'd2lam/mytest'
                })
                .then(result => {
                    assert.deepEqual(result, {
                        envVars: {
                            SD_SONAR_AUTH_URL: `${sdSonarAuthUrl}?projectKey=job:1&projectName=d2lam/mytest:main&username=user-job-1&scope=job`,
                            SD_SONAR_HOST: 'https://sonar.screwdriver.cd',
                            SD_SONAR_ENTERPRISE: false,
                            SD_SONAR_PROJECT_KEY: 'job:1',
                            SD_SONAR_PROJECT_NAME: 'd2lam/mytest:main'
                        }
                    });
                    assert.callCount(requestMock, 0);
                }));

        it('return N/A if it fails to get coverage and tests', () => {
            requestMock.onCall(0).rejects({
                statusCode: 500,
                message: '500 - internal server error'
            });

            return sonarPlugin
                .getInfo({
                    pipelineId: '123',
                    jobId: '1',
                    startTime,
                    endTime,
                    jobName: 'main',
                    pipelineName: 'd2lam/mytest'
                })
                .then(result => {
                    assert.callCount(loggerMock.error, 1);
                    assert.deepEqual(result, {
                        coverage: 'N/A',
                        tests: 'N/A',
                        projectUrl: `${config.sonarHost}/dashboard?id=job%3A1`,
                        envVars: {
                            SD_SONAR_AUTH_URL: `${sdSonarAuthUrl}?projectKey=job:1&projectName=d2lam/mytest:main&username=user-job-1&scope=job`,
                            SD_SONAR_HOST: 'https://sonar.screwdriver.cd',
                            SD_SONAR_ENTERPRISE: false,
                            SD_SONAR_PROJECT_KEY: 'job:1',
                            SD_SONAR_PROJECT_NAME: 'd2lam/mytest:main'
                        }
                    });
                    assert.callCount(requestMock, 1);
                });
        });

        it('return N/A if coverage and tests does not exists on sonar', () => {
            requestMock.onCall(0).rejects({
                statusCode: 404,
                message: '404 - {"errors":[{"msg":"Component key \'job:1\' not found"}]}'
            });

            return sonarPlugin
                .getInfo({
                    pipelineId: '123',
                    jobId: '1',
                    startTime,
                    endTime,
                    jobName: 'main',
                    pipelineName: 'd2lam/mytest'
                })
                .then(result => {
                    assert.notCalled(loggerMock.error);
                    assert.deepEqual(result, {
                        coverage: 'N/A',
                        tests: 'N/A',
                        projectUrl: `${config.sonarHost}/dashboard?id=job%3A1`,
                        envVars: {
                            SD_SONAR_AUTH_URL: `${sdSonarAuthUrl}?projectKey=job:1&projectName=d2lam/mytest:main&username=user-job-1&scope=job`,
                            SD_SONAR_HOST: 'https://sonar.screwdriver.cd',
                            SD_SONAR_ENTERPRISE: false,
                            SD_SONAR_PROJECT_KEY: 'job:1',
                            SD_SONAR_PROJECT_NAME: 'd2lam/mytest:main'
                        }
                    });
                    assert.callCount(requestMock, 1);
                });
        });

        it('return N/A if the error message is an unexpected 404 error', () => {
            requestMock.onCall(0).rejects({
                statusCode: 404,
                message: '404 - Not Found'
            });

            return sonarPlugin
                .getInfo({
                    pipelineId: '123',
                    jobId: '1',
                    startTime,
                    endTime,
                    jobName: 'main',
                    pipelineName: 'd2lam/mytest'
                })
                .then(result => {
                    assert.callCount(loggerMock.error, 1);
                    assert.deepEqual(result, {
                        coverage: 'N/A',
                        tests: 'N/A',
                        projectUrl: `${config.sonarHost}/dashboard?id=job%3A1`,
                        envVars: {
                            SD_SONAR_AUTH_URL: `${sdSonarAuthUrl}?projectKey=job:1&projectName=d2lam/mytest:main&username=user-job-1&scope=job`,
                            SD_SONAR_HOST: 'https://sonar.screwdriver.cd',
                            SD_SONAR_ENTERPRISE: false,
                            SD_SONAR_PROJECT_KEY: 'job:1',
                            SD_SONAR_PROJECT_NAME: 'd2lam/mytest:main'
                        }
                    });
                    assert.callCount(requestMock, 1);
                });
        });

        it('return N/A for tests if it tests metric does not exist', () => {
            const obj = JSON.parse(JSON.stringify(coverageObject));

            delete obj.body.measures[0];
            requestMock.onCall(0).resolves(obj);

            return sonarPlugin
                .getInfo({
                    pipelineId: '123',
                    jobId: '1',
                    startTime,
                    endTime,
                    jobName: 'main',
                    pipelineName: 'd2lam/mytest'
                })
                .then(result =>
                    assert.deepEqual(result, {
                        coverage: '98.8',
                        tests: 'N/A',
                        projectUrl: `${config.sonarHost}/dashboard?id=job%3A1`,
                        envVars: {
                            SD_SONAR_AUTH_URL: `${sdSonarAuthUrl}?projectKey=job:1&projectName=d2lam/mytest:main&username=user-job-1&scope=job`,
                            SD_SONAR_HOST: 'https://sonar.screwdriver.cd',
                            SD_SONAR_ENTERPRISE: false,
                            SD_SONAR_PROJECT_KEY: 'job:1',
                            SD_SONAR_PROJECT_NAME: 'd2lam/mytest:main'
                        }
                    })
                );
        });

        it('return N/A for tests if it tests metric history value is not a number', () => {
            const obj = JSON.parse(JSON.stringify(coverageObject));

            obj.body.measures[0].history[0].value = 'unknown';
            requestMock.onCall(0).resolves(obj);

            return sonarPlugin
                .getInfo({
                    pipelineId: '123',
                    jobId: '1',
                    startTime,
                    endTime,
                    jobName: 'main',
                    pipelineName: 'd2lam/mytest'
                })
                .then(result =>
                    assert.deepEqual(result, {
                        coverage: '98.8',
                        tests: 'N/A',
                        projectUrl: `${config.sonarHost}/dashboard?id=job%3A1`,
                        envVars: {
                            SD_SONAR_AUTH_URL: `${sdSonarAuthUrl}?projectKey=job:1&projectName=d2lam/mytest:main&username=user-job-1&scope=job`,
                            SD_SONAR_HOST: 'https://sonar.screwdriver.cd',
                            SD_SONAR_ENTERPRISE: false,
                            SD_SONAR_PROJECT_KEY: 'job:1',
                            SD_SONAR_PROJECT_NAME: 'd2lam/mytest:main'
                        }
                    })
                );
        });

        it('computes correct result if tests_errors metric is missing', () => {
            const obj = JSON.parse(JSON.stringify(coverageObject));

            delete obj.body.measures[1].history[0].value;
            requestMock.onCall(0).resolves(obj);

            return sonarPlugin
                .getInfo({
                    pipelineId: '123',
                    jobId: '1',
                    startTime,
                    endTime,
                    jobName: 'main',
                    pipelineName: 'd2lam/mytest'
                })
                .then(result =>
                    assert.deepEqual(result, {
                        coverage: '98.8',
                        tests: '9/10',
                        projectUrl: `${config.sonarHost}/dashboard?id=job%3A1`,
                        envVars: {
                            SD_SONAR_AUTH_URL: `${sdSonarAuthUrl}?projectKey=job:1&projectName=d2lam/mytest:main&username=user-job-1&scope=job`,
                            SD_SONAR_HOST: 'https://sonar.screwdriver.cd',
                            SD_SONAR_ENTERPRISE: false,
                            SD_SONAR_PROJECT_KEY: 'job:1',
                            SD_SONAR_PROJECT_NAME: 'd2lam/mytest:main'
                        }
                    })
                );
        });
    });

    describe('getAccessToken', () => {
        const buildCredentials = { jobId: 1, pipelineId: 123 };
        const gitAppEncoded = 'Screwdriver%20Sonar%20PR%20Checks';

        beforeEach(() => {
            requestMock.onCall(1).rejects();
            requestMock.onCall(4).resolves({ token: 'accesstoken' });
        });

        it('gets an access token successfully', () => {
            const projectKey = 'job:1';

            return sonarPlugin.getAccessToken({ buildCredentials }).then(result => {
                assert.callCount(requestMock, 5);
                assert.call(
                    requestMock,
                    sinon.match({
                        url: `https://sonar.screwdriver.cd/api/projects/create?project=${projectKey}&name=${projectKey}`
                    })
                );
                assert.strictEqual(result, 'accesstoken');
            });
        });

        it('gets an access token successfully for enterprise', () => {
            const projectKey = 'pipeline:123';
            const projectName = 'd2lam/mytest';
            const username = 'user-pipeline-123';

            enterpriseSonarPlugin = new SonarPlugin(enterpriseConfig);
            requestMock.onCall(5).resolves({ token: 'accesstoken' });

            return enterpriseSonarPlugin
                .getAccessToken({ buildCredentials, projectKey, username, projectName })
                .then(result => {
                    assert.callCount(requestMock, 6);
                    assert.call(
                        requestMock.firstCall,
                        sinon.match({
                            url: `https://sonar.screwdriver.cd/api/projects/create?project=${projectKey}&name=${projectKey}`
                        })
                    );
                    assert.calledWith(
                        requestMock.thirdCall,
                        sinon.match({
                            url: `https://sonar.screwdriver.cd/api/alm_settings/set_github_binding?almSetting=${gitAppEncoded}&project=pipeline%3A123&repository=${projectName}&summaryCommentEnabled=true`
                        })
                    );
                    assert.call(
                        requestMock.fourthCall,
                        sinon.match({
                            url: `https://sonar.screwdriver.cd/api/permissions/add_user?login=${username}&permission=scan&projectKey=${projectKey}`
                        })
                    );
                    assert.strictEqual(result, 'accesstoken');
                });
        });

        it('gets an access token successfully with existing pipeline', () => {
            requestMock.onCall(0).rejects({
                statusCode: 400,
                message: 'Project already exists.'
            });
            requestMock.onCall(4).resolves({ token: 'accesstoken' });

            return sonarPlugin.getAccessToken({ buildCredentials }).then(result => {
                assert.callCount(requestMock, 5);
                assert.strictEqual(result, 'accesstoken');
            });
        });

        it('gets an access token successfully with existing user', () => {
            requestMock.onCall(2).rejects({
                statusCode: 400,
                message: 'user already exists.'
            });
            requestMock.onCall(4).resolves({ token: 'accesstoken' });

            return sonarPlugin.getAccessToken({ buildCredentials }).then(result => {
                assert.callCount(requestMock, 5);
                assert.strictEqual(result, 'accesstoken');
            });
        });

        it('throws err if failed to create/locate projects', () => {
            requestMock.onCall(0).rejects({
                statusCode: 500,
                message: '500 - internal server error'
            });

            return sonarPlugin
                .getAccessToken({ buildCredentials })
                .then(() => {
                    assert.throws(new Error('should not get here'));
                })
                .catch(err =>
                    assert.deepEqual(err.message, 'Failed to create project job:1: 500 - internal server error')
                );
        });

        it('does not throw if failed to configure Git App', () => {
            requestMock.onCall(2).rejects({
                statusCode: 500,
                message: '500 - internal server error'
            });

            const projectKey = 'pipeline:123';
            const projectName = 'd2lam/mytest';
            const username = 'user-pipeline-123';

            enterpriseSonarPlugin = new SonarPlugin(enterpriseConfig);
            requestMock.onCall(5).resolves({ token: 'accesstoken' });

            // eslint-disable-next-line max-len
            return enterpriseSonarPlugin
                .getAccessToken({ buildCredentials, projectKey, username, projectName })
                .then(result => {
                    assert.callCount(requestMock, 6);
                    assert.callCount(loggerMock.error, 1);
                    assert.strictEqual(result, 'accesstoken');
                });
        });

        it('does not configure Git App if binding already exists', () => {
            requestMock.onCall(1).resolves({});

            const projectKey = 'pipeline:123';
            const projectName = 'd2lam/mytest';
            const username = 'user-pipeline-123';

            enterpriseSonarPlugin = new SonarPlugin(enterpriseConfig);
            requestMock.onCall(4).resolves({ token: 'accesstoken' });

            // eslint-disable-next-line max-len
            return enterpriseSonarPlugin
                .getAccessToken({ buildCredentials, projectKey, username, projectName })
                .then(result => {
                    assert.callCount(requestMock, 5);
                    assert.callCount(loggerMock.error, 0);
                    assert.strictEqual(result, 'accesstoken');
                });
        });

        it('throws err if failed to create/locate user', () => {
            requestMock.onCall(2).rejects({
                statusCode: 500,
                message: '500 - internal server error'
            });

            return sonarPlugin
                .getAccessToken({ buildCredentials })
                .then(() => {
                    assert.throws(new Error('should not get here'));
                })
                .catch(err =>
                    assert.deepEqual(err.message, 'Failed to create user user-job-1: 500 - internal server error')
                );
        });

        it('throws err if failed to grant user permission', () => {
            requestMock.onCall(3).rejects({
                statusCode: 500,
                message: '500 - internal server error'
            });

            return sonarPlugin
                .getAccessToken({ buildCredentials })
                .then(() => {
                    assert.throws(new Error('should not get here'));
                })
                .catch(err =>
                    assert.deepEqual(
                        err.message,
                        'Failed to grant user user-job-1 permission: 500 - internal server error'
                    )
                );
        });

        it('it throws err if failed to generate user token', () => {
            requestMock.onCall(4).rejects({
                statusCode: 500,
                message: '500 - internal server error'
            });

            return sonarPlugin
                .getAccessToken({ buildCredentials })
                .then(() => {
                    assert.throws(new Error('should not get here'));
                })
                .catch(err =>
                    assert.deepEqual(
                        err.message,
                        'Failed to generate user user-job-1 token: 500 - internal server error'
                    )
                );
        });
    });
});
