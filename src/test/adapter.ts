import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import * as path from 'path';
import {DebugClient} from 'vscode-debugadapter-testsupport';
import {DebugProtocol} from 'vscode-debugprotocol';
chai.use(chaiAsPromised);
const assert = chai.assert;

describe('PHP Debug Adapter', () => {

    const TEST_PROJECT = path.normalize(__dirname + '/../../testproject');

    let client: DebugClient;

    beforeEach('start debug adapter', async () => {
        client = new DebugClient('node', path.normalize(__dirname + '/../phpDebug'), 'php');
        await client.start(process.env.VSCODE_DEBUG_PORT && parseInt(process.env.VSCODE_DEBUG_PORT));
    });

    afterEach('stop debug adapter', () =>
        client.stop()
    );

    describe('initialization', () => {

        it('should return supported features', async () => {
            const response = await client.initializeRequest();
            assert.equal(response.body.supportsConfigurationDoneRequest, true);
            assert.equal(response.body.supportsEvaluateForHovers, false);
            assert.equal(response.body.supportsConditionalBreakpoints, true);
            assert.equal(response.body.supportsFunctionBreakpoints, true);
        });
    });

    describe('launch as CLI', () => {

        const program = path.join(TEST_PROJECT, 'hello_world.php');

        it('should error on non-existing file', () =>
            assert.isRejected(client.launch({program: 'thisfiledoesnotexist.php'}))
        );

        it('should run program to the end', () =>
            Promise.all([
                client.launch({program}),
                client.configurationSequence(),
                client.waitForEvent('terminated')
            ])
        );

        it('should stop on entry', async () => {
            const [event] = await Promise.all([
                client.waitForEvent('stopped'),
                client.launch({program, stopOnEntry: true}),
                client.configurationSequence()
            ]);
            assert.propertyVal(event.body, 'reason', 'entry');
        });

        it('should not stop if launched without debugging', () =>
            Promise.all([
                client.launch({program, stopOnEntry: true, noDebug: true}),
                client.waitForEvent('terminated')
            ])
        );
    });

    describe('continuation commands', () => {

        const program = path.join(TEST_PROJECT, 'function.php');

        it('should handle run');
        it('should handle step_over');
        it('should handle step_in');
        it('should handle step_out');

        it('should error on pause request', () =>
            assert.isRejected(client.pauseRequest({threadId: 1}))
        );

        it('should handle disconnect', async () => {
            await Promise.all([
                client.launch({program, stopOnEntry: true}),
                client.waitForEvent('initialized')
            ]);
            await client.disconnectRequest();
        });
    });

    async function assertStoppedLocation(reason: 'entry' | 'breakpoint' | 'exception', path: string, line: number): Promise<{threadId: number, frame: DebugProtocol.StackFrame}> {
        const event = await client.waitForEvent('stopped') as DebugProtocol.StoppedEvent;
        assert.propertyVal(event.body, 'reason', reason);
        const threadId = event.body.threadId;
        const response = await client.stackTraceRequest({threadId});
        const frame = response.body.stackFrames[0];
        let expectedPath = path;
        let actualPath = frame.source.path;
        if (process.platform === 'win32') {
            expectedPath = expectedPath.toLowerCase();
            actualPath = actualPath.toLowerCase();
        }
        assert.equal(actualPath, expectedPath, 'stopped location: path mismatch');
        assert.equal(frame.line, line, 'stopped location: line mismatch');
        return {threadId, frame};
    }

    describe('breakpoints', () => {

        const program = path.join(TEST_PROJECT, 'hello_world.php');

        describe('line breakpoints', () => {

            async function testBreakpointHit(program: string, line: number): Promise<void> {
                await Promise.all([client.launch({program}), client.waitForEvent('initialized')]);
                const breakpoint = (await client.setBreakpointsRequest({breakpoints: [{line}], source: {path: program}})).body.breakpoints[0];
                assert.isTrue(breakpoint.verified, 'breakpoint verification mismatch: verified');
                assert.equal(breakpoint.line, line, 'breakpoint verification mismatch: line');
                await Promise.all([
                    client.configurationDoneRequest(),
                    assertStoppedLocation('breakpoint', program, line)
                ]);
            }

            it('should stop on a breakpoint', () =>
                testBreakpointHit(program, 4)
            );

            it('should stop on a breakpoint in file with spaces in its name', () =>
                testBreakpointHit(path.join(TEST_PROJECT, 'folder with spaces', 'file with spaces.php'), 4)
            );

            it('should stop on a breakpoint identical to the entrypoint', () =>
                testBreakpointHit(program, 3)
            );
        });

        describe('exception breakpoints', () => {

            const program = path.join(TEST_PROJECT, 'error.php');

            beforeEach(() => Promise.all([
                client.launch({program}),
                client.waitForEvent('initialized')
            ]));

            it('should support stopping only on a notice', async () => {
                await client.setExceptionBreakpointsRequest({filters: ['Notice']});
                const [, {threadId}] = await Promise.all([
                    client.configurationDoneRequest(),
                    assertStoppedLocation('exception', program, 6)
                ]);
                await Promise.all([
                    client.continueRequest({threadId}),
                    client.waitForEvent('terminated')
                ]);
            });

            it('should support stopping only on a warning', async () => {
                await client.setExceptionBreakpointsRequest({filters: ['Warning']});
                const [{threadId}] = await Promise.all([
                    assertStoppedLocation('exception', program, 9),
                    client.configurationDoneRequest()
                ]);
                await Promise.all([
                    client.continueRequest({threadId}),
                    client.waitForEvent('terminated')
                ]);
            });

            it('should support stopping only on an exception', async () => {
                await client.setExceptionBreakpointsRequest({filters: ['Exception']});
                const [, {threadId}] = await Promise.all([
                    client.configurationDoneRequest(),
                    assertStoppedLocation('exception', program, 12)
                ]);
                await Promise.all([
                    client.continueRequest({threadId}),
                    client.waitForEvent('terminated')
                ]);
            });

            it('should support stopping on everything', async () => {
                await client.setExceptionBreakpointsRequest({filters: ['*']});
                // Notice
                const [, {threadId}] = await Promise.all([
                    client.configurationDoneRequest(),
                    assertStoppedLocation('exception', program, 6)
                ]);
                // Warning
                await Promise.all([
                    client.continueRequest({threadId}),
                    assertStoppedLocation('exception', program, 9)
                ]);
                // Exception
                await Promise.all([
                    client.continueRequest({threadId}),
                    assertStoppedLocation('exception', program, 12)
                ]);
                // Fatal error: uncaught exception
                await Promise.all([
                    client.continueRequest({threadId}),
                    assertStoppedLocation('exception', program, 12)
                ]);
                await Promise.all([
                    client.continueRequest({threadId}),
                    client.waitForEvent('terminated')
                ]);
            });

            it('should report the error in a virtual error scope');
        });

        describe('conditional breakpoints', () => {

            const program = path.join(TEST_PROJECT, 'variables.php');

            it('should stop on a conditional breakpoint when condition is true', async () => {
                await Promise.all([
                    client.launch({program}),
                    client.waitForEvent('initialized')
                ]);
                const bp = (await client.setBreakpointsRequest({breakpoints: [{line: 10, condition: '$anInt === 123'}], source: {path: program}})).body.breakpoints[0];
                assert.equal(bp.verified, true, 'breakpoint verification mismatch: verified');
                assert.equal(bp.line, 10, 'breakpoint verification mismatch: line');
                const [, {frame}] = await Promise.all([
                    client.configurationDoneRequest(),
                    assertStoppedLocation('breakpoint', program, 10)
                ]);
                const result = (await client.evaluateRequest({context: 'watch', frameId: frame.id, expression: '$anInt'})).body.result;
                assert.equal(result, 123);
            });

            it('should not stop on a conditional breakpoint when condition is false', async () => {
                await Promise.all([
                    client.launch({program}),
                    client.waitForEvent('initialized')
                ]);
                const bp = (await client.setBreakpointsRequest({breakpoints: [{line: 10, condition: '$anInt !== 123'}], source: {path: program}})).body.breakpoints[0];
                assert.equal(bp.verified, true, 'breakpoint verification mismatch: verified');
                assert.equal(bp.line, 10, 'breakpoint verification mismatch: line');
                await Promise.all([
                    client.configurationDoneRequest(),
                    client.waitForEvent('terminated')
                ]);
            });
        });

        describe('function breakpoints', () => {

            const program = path.join(TEST_PROJECT, 'function.php');

            it('should stop on a function breakpoint', async () => {
                await client.launch({program});
                await client.waitForEvent('initialized');
                const breakpoint = (await client.setFunctionBreakpointsRequest({breakpoints: [{name: 'a_function'}]})).body.breakpoints[0];
                assert.strictEqual(breakpoint.verified, true);
                await Promise.all([
                    client.configurationDoneRequest(),
                    assertStoppedLocation('breakpoint', program, 5)
                ]);
            });
        });
    });

    describe('variables', () => {

        const program = path.join(TEST_PROJECT, 'variables.php');

        let localScope: DebugProtocol.Scope;
        let superglobalsScope: DebugProtocol.Scope;
        let constantsScope: DebugProtocol.Scope;

        beforeEach(async () => {
            await Promise.all([
                client.launch({program}),
                client.waitForEvent('initialized')
            ]);
            await client.setBreakpointsRequest({source: {path: program}, breakpoints: [{line: 16}]});
            const [, event] = await Promise.all([
                client.configurationDoneRequest(),
                client.waitForEvent('stopped') as Promise<DebugProtocol.StoppedEvent>
            ]);
            const stackFrame = (await client.stackTraceRequest({threadId: event.body.threadId})).body.stackFrames[0];
            const scopes = (await client.scopesRequest({frameId: stackFrame.id})).body.scopes;
            localScope = scopes.find(scope => scope.name === 'Locals');
            superglobalsScope = scopes.find(scope => scope.name === 'Superglobals');
            constantsScope = scopes.find(scope => scope.name === 'User defined constants');
        });

        it('should report scopes correctly', () => {
            assert.isDefined(localScope, 'Locals');
            assert.isDefined(superglobalsScope, 'Superglobals');
            assert.isDefined(constantsScope, 'User defined constants');
        });

        describe('local variables', () => {

            let localVariables: DebugProtocol.Variable[];

            beforeEach(async () => {
                localVariables = (await client.variablesRequest({variablesReference: localScope.variablesReference})).body.variables;
            });

            it('should report local scalar variables correctly', async () => {
                const variables: {[name: string]: string} = Object.create(null);
                for (const variable of localVariables) {
                    variables[variable.name] = variable.value;
                }
                assert.propertyVal(variables, '$aBoolean', 'true');
                assert.propertyVal(variables, '$aFloat', '1.23');
                assert.propertyVal(variables, '$aString', '"123"');
                assert.propertyVal(variables, '$anEmptyString', '""');
                assert.propertyVal(variables, '$anInt', '123');
                assert.propertyVal(variables, '$nullValue', 'null');
                assert.propertyVal(variables, '$variableThatsNotSet', 'uninitialized');
            });

            it('should report arrays correctly', async () => {
                const anArray = localVariables.find(variable => variable.name === '$anArray');
                assert.isDefined(anArray);
                assert.propertyVal(anArray, 'value', 'array(2)');
                assert.property(anArray, 'variablesReference');
                const items = (await client.variablesRequest({variablesReference: anArray.variablesReference})).body.variables;
                assert.lengthOf(items, 2);
                assert.propertyVal(items[0], 'name', '0');
                assert.propertyVal(items[0], 'value', '1');
                assert.propertyVal(items[1], 'name', 'test');
                assert.propertyVal(items[1], 'value', '2');
            });

            it('should report large arrays correctly', async () => {
                const aLargeArray = localVariables.find(variable => variable.name === '$aLargeArray');
                assert.isDefined(aLargeArray);
                assert.propertyVal(aLargeArray, 'value', 'array(100)');
                assert.property(aLargeArray, 'variablesReference');
                const largeArrayItems = (await client.variablesRequest({variablesReference: aLargeArray.variablesReference})).body.variables;
                assert.lengthOf(largeArrayItems, 100);
                assert.propertyVal(largeArrayItems[0], 'name', '0');
                assert.propertyVal(largeArrayItems[0], 'value', '"test"');
                assert.propertyVal(largeArrayItems[99], 'name', '99');
                assert.propertyVal(largeArrayItems[99], 'value', '"test"');
            });

            it('should report keys with spaces correctly', async () => {
                const arrayWithSpaceKey = localVariables.find(variable => variable.name === '$arrayWithSpaceKey');
                assert.isDefined(arrayWithSpaceKey);
                assert.propertyVal(arrayWithSpaceKey, 'value', 'array(1)');
                assert.property(arrayWithSpaceKey, 'variablesReference');
                const arrayWithSpaceKeyItems = (await client.variablesRequest({variablesReference: arrayWithSpaceKey.variablesReference})).body.variables;
                assert.lengthOf(arrayWithSpaceKeyItems, 1);
                assert.propertyVal(arrayWithSpaceKeyItems[0], 'name', 'space key');
                assert.propertyVal(arrayWithSpaceKeyItems[0], 'value', '1');
            });
        });

        it('should report user defined constants correctly', async () => {
            const constants = (await client.variablesRequest({variablesReference: constantsScope.variablesReference})).body.variables;
            assert.lengthOf(constants, 1);
            assert.propertyVal(constants[0], 'name', 'TEST_CONSTANT');
            assert.propertyVal(constants[0], 'value', '123');
        });
    });

    describe('virtual sources', () => {
        it('should break on an exception inside eval code');
        it('should return the eval code with a source request');
    });

    describe('parallel requests', () => {
        it('should report multiple requests as threads');
    });

    describe('evaluation', () => {
        it('should return the eval result');
        it('should return variable references for structured results');
    });

    describe.skip('output events', () => {

        const program = path.join(TEST_PROJECT, 'output.php');

        it('stdout and stderr events should be complete and in correct order', async () => {
            await Promise.all([
                client.launch({program}),
                client.configurationSequence()
            ]);
            await client.assertOutput('stdout', 'stdout output 1\nstdout output 2');
            await client.assertOutput('stderr', 'stderr output 1\nstderr output 2');
        });
    });
});
