'use strict';

const chai = require('chai');
const sinon = require('sinon');
const path = require('path');
const fsp = require('fs').promises;
const _ = require('lodash');
const log = require('log').get('serverless:test');
const runServerless = require('../../../utils/run-serverless');

// Configure chai
chai.use(require('chai-as-promised'));
const expect = require('chai').expect;

const createApiStub = () => {
  const requests = [];
  return {
    requests,
    stub: sinon.stub().callsFake(async (pathname, { method } = { method: 'GET' }) => {
      log.debug('api request %s', pathname);
      if (pathname.includes('orgs/name/')) {
        requests.push('/orgs/name/{org}');
        const orgName = pathname.split('/').filter(Boolean).pop();
        return { orgId: `${orgName}id` };
      } else if (pathname.includes('/org/')) {
        if (method.toUpperCase() === 'GET') {
          requests.push('get-token');
          return {
            status: 'existing_token',
            token: { accessToken: 'accesss-token' },
          };
        }
      } else if (pathname.endsWith('/token')) {
        if (method.toUpperCase() === 'PATCH') {
          requests.push('activate-token');
          return '';
        }
      } else if (pathname.includes('/tokens?')) {
        if (method.toUpperCase() === 'DELETE') {
          requests.push(
            pathname.includes('token=') ? 'deactivate-other-tokens' : 'deactivate-all-tokens'
          );
          return '';
        }
      } else if (pathname.includes('/token?')) {
        if (method.toUpperCase() === 'DELETE') {
          requests.push('deactivate-token');
          return '';
        }
      }
      throw new Error(`Unexpected request: ${pathname}`);
    }),
  };
};

let serviceName = 'irrelevant';
const createAwsRequestStubMap = () => ({
  CloudFormation: {
    describeStacks: { Stacks: [{ Outputs: [] }] },
    describeStackResource: {
      StackResourceDetail: { PhysicalResourceId: 'deployment-bucket' },
    },
  },
  Lambda: {
    getFunction: {
      Configuration: {
        LastModified: '2020-05-20T15:34:16.494+0000',
      },
    },
  },
  S3: {
    getObject: async ({ Bucket: bucket, Key: key }) => {
      if (bucket !== 'sls-layers-registry') throw new Error(`Unexpected bucket "${bucket}"`);
      if (key !== 'sls-otel-extension-node.json') throw new Error(`Unexpected bucket "${key}"`);
      return {
        Body: Buffer.from(
          JSON.stringify({ 'us-east-1': { '0.5.1': 'latest-sls-otel-layer-arn' } })
        ),
      };
    },
    headObject: async ({ Key: s3Key }) => {
      if (s3Key.includes('sls-otel.')) {
        throw Object.assign(new Error('Not found'), {
          code: 'AWS_S3_HEAD_OBJECT_NOT_FOUND',
        });
      }
      return {
        Metadata: { filesha256: 'RRYyTm4Ri8mocpvx44pvas4JKLYtdJS3Z8MOlrZrDXA=' },
      };
    },
    listObjectsV2: () => ({
      Contents: [
        {
          Key: `serverless/${serviceName}/dev/1589988704359-2020-05-20T15:31:44.359Z/artifact.zip`,
          LastModified: new Date(),
          ETag: '"5102a4cf710cae6497dba9e61b85d0a4"',
          Size: 356,
          StorageClass: 'STANDARD',
        },
        {
          Key: `serverless/${serviceName}/dev/1589988704359-2020-05-20T15:31:44.359Z/compiled-cloudformation-template.json`,
          LastModified: new Date(),
          ETag: '"5102a4cf710cae6497dba9e61b85d0a4"',
          Size: 356,
          StorageClass: 'STANDARD',
        },
        {
          Key: `serverless/${serviceName}/dev/1589988704359-2020-05-20T15:31:44.359Z/serverless-state.json`,
          LastModified: new Date(),
          ETag: '"5102a4cf710cae6497dba9e61b85d0a4"',
          Size: 356,
          StorageClass: 'STANDARD',
        },
      ],
    }),
    headBucket: {},
    upload: sinon.stub().callsFake(async ({ Body: body }) => {
      if (typeof body.destroy === 'function') {
        // Ensure to drain eventual file streams, otherwise file remain locked and
        // on Windows they cannot be removed, resulting with homedir being dirty for next test runs
        await new Promise((resolve, reject) => {
          body.on('data', () => {});
          body.on('end', resolve);
          body.on('error', reject);
        });
      }
      return {};
    }),
  },
  STS: {
    getCallerIdentity: {
      ResponseMetadata: { RequestId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' },
      UserId: 'XXXXXXXXXXXXXXXXXXXXX',
      Account: '999999999999',
      Arn: 'arn:aws:iam::999999999999:user/test',
    },
  },
});

describe('test/unit/lib/classes/console.test.js', () => {
  describe('enabled', () => {
    describe('deploy', () => {
      let cfTemplate;
      let awsNaming;
      let apiStub;
      before(async () => {
        const awsRequestStubMap = createAwsRequestStubMap();
        ({ stub: apiStub } = createApiStub());

        ({ cfTemplate, awsNaming } = await runServerless({
          fixture: 'packaging',
          command: 'deploy',
          lastLifecycleHookName: 'aws:deploy:deploy:uploadArtifacts',
          configExt: { console: true, org: 'testorg' },
          env: { SLS_ORG_TOKEN: 'dummy' },
          modulesCacheStub: {
            [require.resolve('@serverless/utils/api-request')]: apiStub,
          },
          awsRequestStubMap,
        }));
      });

      it('should setup needed environment variables on supported functions', () => {
        const fnVariablesList = [
          cfTemplate.Resources[awsNaming.getLambdaLogicalId('fnService')].Properties.Environment
            .Variables,
          cfTemplate.Resources[awsNaming.getLambdaLogicalId('fnIndividual')].Properties.Environment
            .Variables,
        ];
        for (const fnVariables of fnVariablesList) {
          expect(fnVariables).to.have.property('SLS_EXTENSION');
          expect(fnVariables).to.have.property('AWS_LAMBDA_EXEC_WRAPPER');
        }

        const notSupportedFnVariables = _.get(
          cfTemplate.Resources[awsNaming.getLambdaLogicalId('fnGo')].Properties,
          'Environment.Variables',
          {}
        );
        expect(notSupportedFnVariables).to.not.have.property('SLS_EXTENSION');
        expect(notSupportedFnVariables).to.not.have.property('AWS_LAMBDA_EXEC_WRAPPER');
      });

      it('should reflect default userSettings', () => {
        const userSettings = JSON.parse(
          cfTemplate.Resources[awsNaming.getLambdaLogicalId('fnService')].Properties.Environment
            .Variables.SLS_EXTENSION
        );
        expect(userSettings).to.have.property('ingestToken');
        expect(userSettings).to.have.property('orgId');
      });
    });

    describe('package', () => {
      let userSettings;
      before(async () => {
        const { stub: apiStub } = createApiStub();

        const { cfTemplate, awsNaming } = await runServerless({
          fixture: 'function',
          command: 'package',
          configExt: {
            console: {
              monitoring: { logs: { disabled: true } },
            },
            org: 'testorg',
          },
          env: { SLS_ORG_TOKEN: 'dummy' },
          modulesCacheStub: {
            [require.resolve('@serverless/utils/api-request')]: apiStub,
          },
          awsRequestStubMap: createAwsRequestStubMap(),
        });
        userSettings = JSON.parse(
          cfTemplate.Resources[awsNaming.getLambdaLogicalId('basic')].Properties.Environment
            .Variables.SLS_EXTENSION
        );
      });

      it('should propagate user settings', () => {
        expect(userSettings.logs.disabled).to.be.true;
        expect(userSettings).to.have.property('ingestToken');
      });
    });

    describe('package with "provider.layers" configuration', () => {
      it('should setup console wihout errors', async () => {
        const { cfTemplate, awsNaming } = await runServerless({
          fixture: 'function-layers',
          command: 'package',
          configExt: {
            console: true,
            org: 'testorg',
            layers: {
              extra1: { path: 'test-layer' },
              extra2: { path: 'test-layer' },
            },
            package: {
              individually: true,
            },
            provider: { layers: [{ Ref: 'Extra1LambdaLayer' }, { Ref: 'Extra2LambdaLayer' }] },
            functions: { layerFunc: { layers: null }, capitalLayerFunc: { layers: null } },
          },
          modulesCacheStub: {
            [require.resolve('@serverless/utils/api-request')]: createApiStub().stub,
          },
          awsRequestStubMap: createAwsRequestStubMap(),
          env: { SLS_ORG_TOKEN: 'dummy' },
        });

        const configuredLayers =
          cfTemplate.Resources[awsNaming.getLambdaLogicalId('layerFunc')].Properties.Layers;
        expect(configuredLayers.some((layerArn) => layerArn === 'latest-sls-otel-layer-arn')).to.be
          .true;
      });
    });
  });

  describe('deploy --package', () => {
    let consolePackage;
    let consoleDeploy;
    let servicePath;
    let apiStub;
    let otelIngenstionRequests;
    before(async () => {
      ({ requests: otelIngenstionRequests, stub: apiStub } = createApiStub());

      ({
        serverless: { console: consolePackage },
        fixtureData: { servicePath },
      } = await runServerless({
        fixture: 'function',
        command: 'package',
        options: { package: 'package-dir' },
        configExt: { console: true, org: 'testorg' },
        env: { SLS_ORG_TOKEN: 'dummy' },
        modulesCacheStub: {
          [require.resolve('@serverless/utils/api-request')]: apiStub,
        },
        awsRequestStubMap: createAwsRequestStubMap(),
      }));

      const awsRequestStubMap = createAwsRequestStubMap();

      ({
        serverless: { console: consoleDeploy },
      } = await runServerless({
        cwd: servicePath,
        command: 'deploy',
        lastLifecycleHookName: 'aws:deploy:deploy:uploadArtifacts',
        options: { package: 'package-dir' },
        configExt: { console: true, org: 'testorg' },
        env: { SLS_ORG_TOKEN: 'dummy' },
        modulesCacheStub: {
          [require.resolve('@serverless/utils/api-request')]: apiStub,
        },
        awsRequestStubMap,
      }));
    });

    it('should use service id as stored in the state', () => {
      expect(consoleDeploy.serviceId).to.equal(consolePackage.serviceId);
    });

    it('should activate otel ingestion token', () => {
      otelIngenstionRequests.includes('activate-token');
    });
  });

  describe('deploy function', () => {
    let updateFunctionStub;
    let publishLayerStub;
    let apiStub;
    let otelIngenstionRequests;
    before(async () => {
      updateFunctionStub = sinon.stub().resolves({});
      publishLayerStub = sinon.stub().resolves({});
      const awsRequestStubMap = createAwsRequestStubMap();
      ({ requests: otelIngenstionRequests, stub: apiStub } = createApiStub());

      await runServerless({
        fixture: 'function',
        command: 'deploy function',
        options: { function: 'basic' },
        configExt: { console: true, org: 'testorg' },
        env: { SLS_ORG_TOKEN: 'dummy' },
        modulesCacheStub: {
          [require.resolve('@serverless/utils/api-request')]: apiStub,
        },
        awsRequestStubMap: {
          ...awsRequestStubMap,
          Lambda: {
            getFunction: {
              Configuration: {
                State: 'Active',
                LastUpdateStatus: 'Successful',
                Layers: [
                  {
                    Arn: 'arn:aws:lambda:us-east-1:999999999999:layer:sls-otel-extension-node-0-3-6:1',
                    CodeSize: 186038,
                    SigningProfileVersionArn: null,
                    SigningJobArn: null,
                  },
                  {
                    Arn: 'other-layer',
                    CodeSize: 186038,
                    SigningProfileVersionArn: null,
                    SigningJobArn: null,
                  },
                ],
              },
            },
            publishLayerVersion: publishLayerStub,
            updateFunctionConfiguration: updateFunctionStub,
            updateFunctionCode: {},
          },
        },
      });
    });

    it('should setup needed environment variables', () => {
      const fnVariables = updateFunctionStub.args[0][0].Environment.Variables;
      expect(fnVariables).to.have.property('SLS_EXTENSION');
      expect(fnVariables).to.have.property('AWS_LAMBDA_EXEC_WRAPPER');
    });

    it('should keep already attached lambda layers', async () => {
      const layers = updateFunctionStub.args[0][0].Layers;
      expect(layers.sort()).to.deep.equal(['other-layer', 'latest-sls-otel-layer-arn'].sort());
    });

    it('should activate otel ingestion token', () => {
      otelIngenstionRequests.includes('activate-token');
    });
  });

  describe('rollback', () => {
    let slsConsole;
    let apiStub;
    let otelIngenstionRequests;
    before(async () => {
      const awsRequestStubMap = createAwsRequestStubMap();
      ({ requests: otelIngenstionRequests, stub: apiStub } = createApiStub());

      ({
        serverless: { console: slsConsole },
      } = await runServerless({
        fixture: 'function',
        command: 'rollback',
        options: { timestamp: '2020-05-20T15:31:44.359Z' },
        configExt: { console: true, org: 'testorg' },
        env: { SLS_ORG_TOKEN: 'dummy' },
        modulesCacheStub: {
          [require.resolve('@serverless/utils/api-request')]: apiStub,
        },
        awsRequestStubMap: {
          ...awsRequestStubMap,
          S3: {
            ...awsRequestStubMap.S3,
            getObject: async ({ Key: s3Key }) => {
              if (s3Key.endsWith('/serverless-state.json')) {
                return {
                  Body: JSON.stringify({
                    console: {
                      schemaVersion: '2',
                      otelIngestionToken: 'rollback-token',
                      service: 'test-console',
                      stage: 'dev',
                      orgId: 'testorgid',
                    },
                  }),
                };
              }
              throw new Error(`Unexpected request: ${s3Key}`);
            },
          },
          CloudFormation: {
            ...awsRequestStubMap.CloudFormation,
            deleteChangeSet: {},
            createChangeSet: {},
            describeChangeSet: {
              Status: 'CREATE_COMPLETE',
            },
            executeChangeSet: {},
            describeStackEvents: {
              StackEvents: [
                {
                  EventId: '1',
                  ResourceType: 'AWS::CloudFormation::Stack',
                  ResourceStatus: 'UPDATE_COMPLETE',
                },
              ],
            },
          },
        },
        hooks: {
          beforeInstanceRun: (serverless) => {
            serviceName = serverless.service.service;
          },
        },
      }));
    });

    it('should resolve otel ingestion token from the state', async () => {
      expect(await slsConsole.deferredOtelIngestionToken).to.equal('rollback-token');
    });

    it('should activate otel ingestion token', () => {
      otelIngenstionRequests.includes('activate-token');
    });
  });

  describe('remove', () => {
    let otelIngenstionRequests;
    let apiStub;
    before(async () => {
      const awsRequestStubMap = createAwsRequestStubMap();
      ({ requests: otelIngenstionRequests, stub: apiStub } = createApiStub());

      await runServerless({
        fixture: 'function',
        command: 'remove',
        configExt: { console: true, org: 'testorg' },
        env: { SLS_ORG_TOKEN: 'dummy' },
        modulesCacheStub: {
          [require.resolve('@serverless/utils/api-request')]: apiStub,
        },
        awsRequestStubMap: {
          ...awsRequestStubMap,
          CloudFormation: {
            ...awsRequestStubMap.CloudFormation,
            deleteStack: {},
            describeStackEvents: {
              StackEvents: [
                {
                  EventId: '1',
                  ResourceType: 'AWS::CloudFormation::Stack',
                  ResourceStatus: 'DELETE_COMPLETE',
                },
              ],
            },
          },
          ECR: {
            async describeRepositories() {
              throw Object.assign(new Error('RepositoryNotFoundException'), {
                providerError: { code: 'RepositoryNotFoundException' },
              });
            },
          },
          S3: {
            ...awsRequestStubMap.S3,
            deleteObjects: {},
          },
        },
      });
    });

    it('should deactivate all ingestion tokens', () => {
      otelIngenstionRequests.includes('deactivate-all-token');
    });
  });

  it('should support "console.org"', async () => {
    const { requests: otelIngenstionRequests, stub: apiStub } = createApiStub();

    await runServerless({
      fixture: 'function',
      command: 'package',
      configExt: {
        console: {
          org: 'testorg',
        },
        org: 'ignore',
      },
      env: { SLS_ORG_TOKEN: 'dummy' },
      modulesCacheStub: {
        [require.resolve('@serverless/utils/api-request')]: apiStub,
      },
      awsRequestStubMap: createAwsRequestStubMap(),
    });

    for (const [url] of apiStub.args) expect(url).to.not.include('/ignoreid/');
    otelIngenstionRequests.includes('activate-token');
  });

  describe('errors', () => {
    it('should abort when console enabled but not authenticated', async () => {
      await expect(
        runServerless({
          fixture: 'function',
          command: 'package',
          configExt: { console: true, org: 'testorg' },
        })
      ).to.eventually.be.rejected.and.have.property('code', 'CONSOLE_NOT_AUTHENTICATED');
    });

    it('should abort when function has already maximum numbers of layers configured', async () => {
      await expect(
        runServerless({
          fixture: 'function-layers',
          command: 'package',
          configExt: {
            console: true,
            org: 'testorg',
            layers: {
              extra1: { path: 'test-layer' },
              extra2: { path: 'test-layer' },
            },
            functions: {
              layerFuncWithConfig: {
                layers: [
                  { Ref: 'TestLayerLambdaLayer' },
                  { Ref: 'TestLayerWithCapitalsLambdaLayer' },
                  { Ref: 'TestLayerWithNoNameLambdaLayer' },
                  { Ref: 'Extra1LambdaLayer' },
                  { Ref: 'Extra2LambdaLayer' },
                ],
              },
            },
          },
          modulesCacheStub: {
            [require.resolve('@serverless/utils/api-request')]: createApiStub().stub,
          },
          awsRequestStubMap: createAwsRequestStubMap(),
          env: { SLS_ORG_TOKEN: 'dummy' },
        })
      ).to.eventually.be.rejected.and.have.property('code', 'TOO_MANY_LAYERS_TO_SETUP_CONSOLE');
    });

    it(
      'should throw integration error when attempting to deploy package, ' +
        'packaged with different console integration version',
      async () => {
        const {
          fixtureData: { servicePath },
        } = await runServerless({
          fixture: 'function',
          command: 'package',
          options: { package: 'package-dir' },
          configExt: { console: true, org: 'testorg' },
          env: { SLS_ORG_TOKEN: 'dummy' },
          modulesCacheStub: {
            [require.resolve('@serverless/utils/api-request')]: createApiStub().stub,
          },
          awsRequestStubMap: createAwsRequestStubMap(),
        });
        const stateFilename = path.resolve(servicePath, 'package-dir', 'serverless-state.json');
        const state = JSON.parse(await fsp.readFile(stateFilename, 'utf-8'));
        state.console.schemaVersion = 'other';
        await fsp.writeFile(stateFilename, JSON.stringify(state));
        await expect(
          runServerless({
            cwd: servicePath,
            command: 'deploy',
            lastLifecycleHookName: 'aws:deploy:deploy:uploadArtifacts',
            options: { package: 'package-dir' },
            configExt: { console: true, org: 'testorg' },
            env: { SLS_ORG_TOKEN: 'dummy' },
            modulesCacheStub: {
              [require.resolve('@serverless/utils/api-request')]: createApiStub().stub,
            },
            awsRequestStubMap: createAwsRequestStubMap(),
          })
        ).to.eventually.be.rejected.and.have.property('code', 'CONSOLE_INTEGRATION_MISMATCH');
      }
    );
    it(
      'should throw mismatch error when attempting to deploy package, ' +
        'packaged with different org',
      async () => {
        const {
          fixtureData: { servicePath, updateConfig },
        } = await runServerless({
          fixture: 'function',
          command: 'package',
          options: { package: 'package-dir' },
          configExt: { console: true, org: 'other' },
          env: { SLS_ORG_TOKEN: 'dummy' },
          modulesCacheStub: {
            [require.resolve('@serverless/utils/api-request')]: createApiStub().stub,
          },
          awsRequestStubMap: createAwsRequestStubMap(),
        });

        await updateConfig({ org: 'testorg' });

        await expect(
          runServerless({
            cwd: servicePath,
            command: 'deploy',
            lastLifecycleHookName: 'aws:deploy:deploy:uploadArtifacts',
            options: { package: 'package-dir' },
            env: { SLS_ORG_TOKEN: 'dummy' },
            modulesCacheStub: {
              [require.resolve('@serverless/utils/api-request')]: createApiStub().stub,
            },
            awsRequestStubMap: createAwsRequestStubMap(),
          })
        ).to.eventually.be.rejected.and.have.property('code', 'CONSOLE_ORG_MISMATCH');
      }
    );
    it(
      'should throw mismatch error when attempting to deploy package, ' +
        'packaged with different region',
      async () => {
        const {
          fixtureData: { servicePath, updateConfig },
        } = await runServerless({
          fixture: 'function',
          command: 'package',
          options: { package: 'package-dir' },
          configExt: { console: true, org: 'testorg' },
          env: { SLS_ORG_TOKEN: 'dummy' },
          modulesCacheStub: {
            [require.resolve('@serverless/utils/api-request')]: createApiStub().stub,
          },
          awsRequestStubMap: createAwsRequestStubMap(),
        });

        await updateConfig({ provider: { region: 'us-east-2' } });

        await expect(
          runServerless({
            cwd: servicePath,
            command: 'deploy',
            lastLifecycleHookName: 'aws:deploy:deploy:uploadArtifacts',
            options: { package: 'package-dir' },
            env: { SLS_ORG_TOKEN: 'dummy' },
            modulesCacheStub: {
              [require.resolve('@serverless/utils/api-request')]: createApiStub().stub,
            },
            awsRequestStubMap: createAwsRequestStubMap(),
          })
        ).to.eventually.be.rejected.and.have.property('code', 'CONSOLE_REGION_MISMATCH');
      }
    );
    it(
      'should throw activation mismatch error when attempting to deploy with ' +
        'console integration off, but packaged with console integration on',
      async () => {
        const {
          fixtureData: { servicePath, updateConfig },
        } = await runServerless({
          fixture: 'function',
          command: 'package',
          options: { package: 'package-dir' },
          configExt: { console: true, org: 'testorg' },
          env: { SLS_ORG_TOKEN: 'dummy' },
          modulesCacheStub: {
            [require.resolve('@serverless/utils/api-request')]: createApiStub().stub,
          },
          awsRequestStubMap: createAwsRequestStubMap(),
        });
        const stateFilename = path.resolve(servicePath, 'package-dir', 'serverless-state.json');
        const state = JSON.parse(await fsp.readFile(stateFilename, 'utf-8'));
        state.console.orgId = 'other';
        await fsp.writeFile(stateFilename, JSON.stringify(state));
        await updateConfig({ org: null, console: null });
        await expect(
          runServerless({
            cwd: servicePath,
            command: 'deploy',
            lastLifecycleHookName: 'aws:deploy:deploy:uploadArtifacts',
            options: { package: 'package-dir' },
            env: { SLS_ORG_TOKEN: 'dummy' },
            modulesCacheStub: {
              [require.resolve('@serverless/utils/api-request')]: createApiStub().stub,
            },
            awsRequestStubMap: createAwsRequestStubMap(),
          })
        ).to.eventually.be.rejected.and.have.property('code', 'CONSOLE_ACTIVATION_MISMATCH');
      }
    );

    it(
      'should throw integration error when attempting to rollback deployment, ' +
        'to one deployed with different console integration version',
      async () => {
        const awsRequestStubMap = createAwsRequestStubMap();
        await expect(
          runServerless({
            fixture: 'function',
            command: 'rollback',
            lastLifecycleHookName: 'aws:deploy:deploy:uploadArtifacts',
            options: { timestamp: '2020-05-20T15:31:44.359Z' },
            configExt: { console: true, org: 'testorg' },
            env: { SLS_ORG_TOKEN: 'dummy' },
            modulesCacheStub: {
              [require.resolve('@serverless/utils/api-request')]: createApiStub().stub,
            },
            awsRequestStubMap: {
              ...awsRequestStubMap,
              S3: {
                ...awsRequestStubMap.S3,
                getObject: async ({ Key: s3Key }) => {
                  if (s3Key.endsWith('/serverless-state.json')) {
                    return {
                      Body: JSON.stringify({
                        console: {
                          schemaVersion: 'other',
                          otelIngestionToken: 'rollback-token',
                          service: 'test-console',
                          stage: 'dev',
                          orgId: 'testorgid',
                        },
                      }),
                    };
                  }
                  throw new Error(`Unexpected request: ${s3Key}`);
                },
              },
              CloudFormation: {
                ...awsRequestStubMap.CloudFormation,
                deleteChangeSet: {},
                createChangeSet: {},
                describeChangeSet: {
                  Status: 'CREATE_COMPLETE',
                },
                executeChangeSet: {},
                describeStackEvents: {
                  StackEvents: [
                    {
                      EventId: '1',
                      ResourceType: 'AWS::CloudFormation::Stack',
                      ResourceStatus: 'UPDATE_COMPLETE',
                    },
                  ],
                },
              },
            },
            hooks: {
              beforeInstanceRun: (serverless) => {
                serviceName = serverless.service.service;
              },
            },
          })
        ).to.eventually.be.rejected.and.have.property(
          'code',
          'CONSOLE_INTEGRATION_MISMATCH_ROLLBACK'
        );
      }
    );
    it(
      'should throw integration error when attempting to rollback deployment, ' +
        'to one deployed with different org',
      async () => {
        const awsRequestStubMap = createAwsRequestStubMap();
        await expect(
          runServerless({
            fixture: 'function',
            command: 'rollback',
            lastLifecycleHookName: 'aws:deploy:deploy:uploadArtifacts',
            options: { timestamp: '2020-05-20T15:31:44.359Z' },
            configExt: { console: true, org: 'testorg' },
            env: { SLS_ORG_TOKEN: 'dummy' },
            modulesCacheStub: {
              [require.resolve('@serverless/utils/api-request')]: createApiStub().stub,
            },
            awsRequestStubMap: {
              ...awsRequestStubMap,
              S3: {
                ...awsRequestStubMap.S3,
                getObject: async ({ Key: s3Key }) => {
                  if (s3Key.endsWith('/serverless-state.json')) {
                    return {
                      Body: JSON.stringify({
                        console: {
                          schemaVersion: '2',
                          otelIngestionToken: 'rollback-token',
                          service: 'test-console',
                          stage: 'dev',
                          orgId: 'othertestorgid',
                        },
                      }),
                    };
                  }
                  throw new Error(`Unexpected request: ${s3Key}`);
                },
              },
              CloudFormation: {
                ...awsRequestStubMap.CloudFormation,
                deleteChangeSet: {},
                createChangeSet: {},
                describeChangeSet: {
                  Status: 'CREATE_COMPLETE',
                },
                executeChangeSet: {},
                describeStackEvents: {
                  StackEvents: [
                    {
                      EventId: '1',
                      ResourceType: 'AWS::CloudFormation::Stack',
                      ResourceStatus: 'UPDATE_COMPLETE',
                    },
                  ],
                },
              },
            },
            hooks: {
              beforeInstanceRun: (serverless) => {
                serviceName = serverless.service.service;
              },
            },
          })
        ).to.eventually.be.rejected.and.have.property('code', 'CONSOLE_ORG_MISMATCH_ROLLBACK');
      }
    );

    it(
      'should throw integration error when attempting to rollback deployment, ' +
        'deployed with console, while having console disabled',
      async () => {
        const awsRequestStubMap = createAwsRequestStubMap();
        await expect(
          runServerless({
            fixture: 'function',
            command: 'rollback',
            lastLifecycleHookName: 'aws:deploy:deploy:uploadArtifacts',
            options: { timestamp: '2020-05-20T15:31:44.359Z' },
            env: { SLS_ORG_TOKEN: 'dummy' },
            modulesCacheStub: {
              [require.resolve('@serverless/utils/api-request')]: createApiStub().stub,
            },
            awsRequestStubMap: {
              ...awsRequestStubMap,
              S3: {
                ...awsRequestStubMap.S3,
                getObject: async ({ Key: s3Key }) => {
                  if (s3Key.endsWith('/serverless-state.json')) {
                    return {
                      Body: JSON.stringify({
                        console: {
                          schemaVersion: '2',
                          otelIngestionToken: 'rollback-token',
                          service: 'test-console',
                          stage: 'dev',
                          orgId: 'othertestorgid',
                        },
                      }),
                    };
                  }
                  throw new Error(`Unexpected request: ${s3Key}`);
                },
              },
              CloudFormation: {
                ...awsRequestStubMap.CloudFormation,
                deleteChangeSet: {},
                createChangeSet: {},
                describeChangeSet: {
                  Status: 'CREATE_COMPLETE',
                },
                executeChangeSet: {},
                describeStackEvents: {
                  StackEvents: [
                    {
                      EventId: '1',
                      ResourceType: 'AWS::CloudFormation::Stack',
                      ResourceStatus: 'UPDATE_COMPLETE',
                    },
                  ],
                },
              },
            },
            hooks: {
              beforeInstanceRun: (serverless) => {
                serviceName = serverless.service.service;
              },
            },
          })
        ).to.eventually.be.rejected.and.have.property(
          'code',
          'CONSOLE_ACTIVATION_MISMATCH_ROLLBACK'
        );
      }
    );
  });

  describe('disabled', () => {
    it('should not enable console when no `console: true`', async () => {
      const { serverless } = await runServerless({
        fixture: 'function',
        command: 'package',
        configExt: { org: 'testorg' },
      });
      expect(serverless.console.isEnabled).to.be.false;
    });
    it('should not enable console when not supported command', async () => {
      const { serverless } = await runServerless({
        fixture: 'function',
        command: 'print',
        configExt: { console: true, org: 'testorg' },
      });
      expect(serverless.console.isEnabled).to.be.false;
    });
    it('should not enable when no supported functions', async () => {
      const { serverless } = await runServerless({
        fixture: 'aws',
        command: 'package',
        configExt: { console: true, org: 'testorg' },
      });
      expect(serverless.console.isEnabled).to.be.false;
    });
  });
});
