import * as assert from 'node:assert/strict';
import {
    approveCreatedProjectSync,
    consumeCreatedProjectSyncAuthorization,
    CREATED_PROJECT_AUTHORIZATION_KEY,
    SyncAuthorizationStorage,
} from '../utils/createdProjectAuthorization';
import { createSyncTargetFingerprint, isSyncTargetApproved, SyncAuthorizationTarget } from '../utils/syncAuthorization';
import { runStandaloneTest } from './standaloneRunner';

const WORKSPACE_KEY = 'localleaf.approvedSyncTargets.v1';
const target: SyncAuthorizationTarget = {
    workspaceUri: 'file:///D:/created/project', serverUrl: 'https://overleaf.example', projectId: 'created-project',
};

class MemoryState implements SyncAuthorizationStorage {
    readonly values = new Map<string, unknown>();
    readonly writes: string[] = [];
    beforeUpdate?: (key: string, value: unknown) => Promise<void>;

    get<T>(key: string): T | undefined {
        return structuredClone(this.values.get(key)) as T | undefined;
    }

    async update(key: string, value: unknown): Promise<void> {
        this.writes.push(key);
        await this.beforeUpdate?.(key, value);
        this.values.set(key, structuredClone(value));
    }
}

const consume = (global: MemoryState, workspace: MemoryState, requested = target) =>
    consumeCreatedProjectSyncAuthorization(global, workspace, requested, WORKSPACE_KEY);

async function testExactTargetAndSingleConsumption(): Promise<void> {
    const global = new MemoryState();
    const workspace = new MemoryState();
    await approveCreatedProjectSync(global, target);
    for (const other of [
        { ...target, workspaceUri: 'file:///D:/created/other' },
        { ...target, serverUrl: 'https://another.example' },
        { ...target, projectId: 'another-project' },
    ]) assert.equal(await consume(global, workspace, other), false, 'only the exact approved target may consume consent');
    assert.equal(workspace.writes.length, 0);
    assert.equal(await consume(global, workspace), true);
    assert.ok(isSyncTargetApproved(workspace.get(WORKSPACE_KEY), target));
    assert.deepEqual(global.get(CREATED_PROJECT_AUTHORIZATION_KEY), []);
    assert.equal(await consume(global, new MemoryState()), false, 'the handoff must be one-time');
}

async function testMalformedRecordsAndTargets(): Promise<void> {
    const global = new MemoryState();
    const workspace = new MemoryState();
    for (const malformed of [
        undefined, null, {}, 'not a list',
        [null, { workspaceUri: target.workspaceUri, fingerprint: 'invalid' }],
        [{ workspaceUri: 'https://untrusted.example/folder', fingerprint: createSyncTargetFingerprint(target) }],
        [{ workspaceUri: target.workspaceUri, fingerprint: 42 }],
    ]) {
        global.values.set(CREATED_PROJECT_AUTHORIZATION_KEY, malformed);
        assert.equal(await consume(global, workspace), false);
    }
    assert.equal(workspace.writes.length, 0);
    assert.throws(() => approveCreatedProjectSync(global, { ...target, workspaceUri: 'https://untrusted.example/path' }), /workspace target/);
    assert.throws(() => approveCreatedProjectSync(global, { ...target, serverUrl: 'https://user:password@example.com' }), /credentials/);
    assert.throws(() => approveCreatedProjectSync(global, { ...target, projectId: '' }), /project ID/);
    assert.throws(() => consumeCreatedProjectSyncAuthorization(global, workspace, target, ''), /authorization key/);
}

async function testFailedWorkspaceGrantPreservesConsent(): Promise<void> {
    const global = new MemoryState();
    const workspace = new MemoryState();
    await approveCreatedProjectSync(global, target);
    const original = global.get(CREATED_PROJECT_AUTHORIZATION_KEY);
    workspace.beforeUpdate = async () => { throw new Error('workspace storage unavailable'); };
    await assert.rejects(consume(global, workspace), /workspace storage unavailable/);
    assert.deepEqual(global.get(CREATED_PROJECT_AUTHORIZATION_KEY), original,
        'failed workspace persistence must leave the pending approval available');
    assert.equal(workspace.get(WORKSPACE_KEY), undefined);
    workspace.beforeUpdate = undefined;
    assert.equal(await consume(global, workspace), true, 'a later attempt may safely consume the same explicit consent');
}

async function testFailedCleanupLeavesDurableGrant(): Promise<void> {
    const global = new MemoryState();
    const workspace = new MemoryState();
    await approveCreatedProjectSync(global, target);
    global.beforeUpdate = async () => { throw new Error('global storage unavailable'); };
    await assert.rejects(consume(global, workspace), /global storage unavailable/);
    assert.ok(isSyncTargetApproved(workspace.get(WORKSPACE_KEY), target),
        'the workspace grant must be persisted before removing the pending approval');
    assert.ok(isSyncTargetApproved(global.get(CREATED_PROJECT_AUTHORIZATION_KEY), target));
    global.beforeUpdate = undefined;
    assert.equal(await consume(global, workspace), true, 'cleanup is safe to retry after the grant already exists');
}

async function testBoundAndConcurrentCapture(): Promise<void> {
    const global = new MemoryState();
    await Promise.all(Array.from({ length: 70 }, (_, index) => approveCreatedProjectSync(global, {
        ...target, workspaceUri: `file:///D:/created/project-${index}`, projectId: `project-${index}`,
    })));
    const entries = global.get<Array<{ workspaceUri: string; fingerprint: string }>>(CREATED_PROJECT_AUTHORIZATION_KEY)!;
    assert.equal(entries.length, 64, 'pending approvals remain bounded during concurrent creation completion');
    assert.equal(entries[0].workspaceUri, 'file:///D:/created/project-6');
    assert.equal(entries[63].workspaceUri, 'file:///D:/created/project-69');

    const mutable = { ...target };
    const queued = approveCreatedProjectSync(global, mutable);
    mutable.projectId = 'changed-after-consent';
    mutable.workspaceUri = 'file:///D:/unexpected';
    await queued;
    assert.ok(isSyncTargetApproved(global.get(CREATED_PROJECT_AUTHORIZATION_KEY), target),
        'asynchronous persistence must use the target captured when consent was granted');
    assert.equal(isSyncTargetApproved(global.get(CREATED_PROJECT_AUTHORIZATION_KEY), mutable), false);

    const replacement = { ...target, projectId: 'new-consent-for-same-folder' };
    await approveCreatedProjectSync(global, replacement);
    assert.equal(await consume(global, new MemoryState()), false, 'new consent for a folder replaces its older target');
    assert.equal(await consume(global, new MemoryState(), replacement), true);
}

async function testOtherPendingTargetsSurviveConsumption(): Promise<void> {
    const global = new MemoryState();
    const workspace = new MemoryState();
    const second = { ...target, workspaceUri: 'file:///D:/created/second' };
    await Promise.all([approveCreatedProjectSync(global, target), approveCreatedProjectSync(global, second)]);
    assert.equal(await consume(global, workspace), true);
    assert.ok(isSyncTargetApproved(global.get(CREATED_PROJECT_AUTHORIZATION_KEY), second));
    assert.equal(await consume(global, new MemoryState(), second), true);
    assert.deepEqual(global.get(CREATED_PROJECT_AUTHORIZATION_KEY), []);
}

async function run(): Promise<void> {
    await testExactTargetAndSingleConsumption();
    await testMalformedRecordsAndTargets();
    await testFailedWorkspaceGrantPreservesConsent();
    await testFailedCleanupLeavesDurableGrant();
    await testBoundAndConcurrentCapture();
    await testOtherPendingTargetsSurviveConsumption();
    console.log('Created-project authorization handoff regression tests passed.');
}

runStandaloneTest(run);
