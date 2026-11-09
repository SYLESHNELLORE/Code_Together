// Load server/.env before Prisma is constructed so `npm test` works without
// exporting DATABASE_URL in the shell. With no .env, the suite is skipped.
import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import { csrfClient, registerTestUser, type TestSession } from './authTestUtils.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const integration = hasDatabase ? describe : describe.skip;

interface InvitationPayload {
  invitation: {
    id: string;
    email: string | null;
    role: string;
    status: string;
  };
  token: string;
}

interface ProjectPayload {
  id: string;
  name: string;
  role?: string;
  _count?: { members: number };
}

integration('project teams, roles and invitations (requires MySQL)', () => {
  const createdProjectIds: string[] = [];
  const createdUserIds: string[] = [];

  afterAll(async () => {
    // Only delete rows created by this suite. Project deletion cascades to
    // files, memberships and invitations; user deletion cascades to sessions.
    if (createdProjectIds.length > 0) {
      await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.$disconnect();
  });

  async function newSession(prefix: string): Promise<TestSession> {
    const session = await registerTestUser(prefix);
    createdUserIds.push(session.user.id);
    return session;
  }

  async function createProject(owner: TestSession, label: string): Promise<ProjectPayload> {
    const response = await csrfClient(owner)
      .post('/api/projects')
      .send({ name: `team-${label}-${Date.now()}`, description: 'Phase 3 team test' });

    expect(response.status).toBe(201);
    createdProjectIds.push(response.body.data.id);
    return response.body.data as ProjectPayload;
  }

  async function createInvitation(
    actor: TestSession,
    projectId: string,
    email: string,
    role: 'ADMIN' | 'EDITOR' | 'VIEWER' = 'EDITOR',
    expiresInDays = 7,
  ) {
    const response = await csrfClient(actor)
      .post(`/api/projects/${projectId}/invitations`)
      .send({ email, role, expiresInDays });

    expect(response.status).toBe(201);
    return response.body.data as InvitationPayload;
  }

  async function joinByInvitation(
    owner: TestSession,
    projectId: string,
    invitee: TestSession,
    role: 'ADMIN' | 'EDITOR' | 'VIEWER',
  ) {
    const created = await createInvitation(owner, projectId, invitee.user.email, role);
    const accepted = await csrfClient(invitee)
      .post('/api/invitations/accept')
      .send({ token: created.token });

    expect(accepted.status).toBe(200);
    expect(accepted.body.data.role).toBe(role);
    return created;
  }

  it('adds the owner to the roster and never allows ownership changes', async () => {
    const owner = await newSession('team_owner');
    const project = await createProject(owner, 'owner');
    const ownerClient = csrfClient(owner);

    const members = await ownerClient.get(`/api/projects/${project.id}/members`);
    expect(members.status).toBe(200);
    expect(members.body.data).toHaveLength(1);
    expect(members.body.data[0]).toMatchObject({
      userId: owner.user.id,
      role: 'OWNER',
    });

    const listed = await ownerClient.get('/api/projects');
    const listedProject = listed.body.data.find((item: ProjectPayload) => item.id === project.id);
    expect(listedProject.role).toBe('OWNER');
    expect(listedProject._count.members).toBe(1);

    const demote = await ownerClient
      .patch(`/api/projects/${project.id}/members/${owner.user.id}`)
      .send({ role: 'ADMIN' });
    expect(demote.status).toBe(403);
    expect(demote.body.error.code).toBe('OWNER_IMMUTABLE');

    const remove = await ownerClient.delete(`/api/projects/${project.id}/members/${owner.user.id}`);
    expect(remove.status).toBe(403);
    expect(remove.body.error.code).toBe('OWNER_IMMUTABLE');
  }, 30000);

  it('stores only a token hash, accepts an invitation once and enforces viewer read-only access', async () => {
    const owner = await newSession('team_owner');
    const viewer = await newSession('team_viewer');
    const project = await createProject(owner, 'viewer');
    const ownerClient = csrfClient(owner);
    const viewerClient = csrfClient(viewer);

    const created = await createInvitation(owner, project.id, viewer.user.email, 'VIEWER');
    expect(created.invitation.status).toBe('PENDING');

    const stored = await prisma.projectInvitation.findUniqueOrThrow({
      where: { id: created.invitation.id },
    });
    expect(stored.tokenHash).toBe(createHash('sha256').update(created.token).digest('hex'));
    expect(stored.tokenHash).not.toBe(created.token);
    expect(JSON.stringify(stored)).not.toContain(created.token);

    const inbox = await viewerClient.get('/api/invitations/mine');
    expect(inbox.status).toBe(200);
    expect(inbox.body.data.map((item: { id: string }) => item.id)).toContain(created.invitation.id);
    expect(inbox.body.data[0].alreadyMember).toBe(false);

    const preview = await viewerClient
      .post('/api/invitations/preview')
      .send({ token: created.token });
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({
      role: 'VIEWER',
      alreadyMember: false,
      project: { id: project.id },
    });
    expect(preview.body.data.project).not.toHaveProperty('ownerId');

    const accepted = await viewerClient
      .post('/api/invitations/accept')
      .send({ token: created.token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data).toMatchObject({
      role: 'VIEWER',
      alreadyMember: false,
      project: { id: project.id },
    });

    const reused = await viewerClient
      .post('/api/invitations/accept')
      .send({ token: created.token });
    expect(reused.status).toBe(404);
    expect(reused.body.error.code).toBe('INVITATION_INVALID');

    const previewAfterUse = await viewerClient
      .post('/api/invitations/preview')
      .send({ token: created.token });
    expect(previewAfterUse.status).toBe(404);

    const inboxAfterUse = await viewerClient.get('/api/invitations/mine');
    expect(inboxAfterUse.body.data.map((item: { id: string }) => item.id))
      .not.toContain(created.invitation.id);

    const projectRead = await viewerClient.get(`/api/projects/${project.id}`);
    expect(projectRead.status).toBe(200);
    expect(projectRead.body.data.role).toBe('VIEWER');

    const fileRead = await viewerClient.get(`/api/projects/${project.id}/files`);
    expect(fileRead.status).toBe(200);
    expect(fileRead.body.data).toEqual([]);

    const fileWrite = await viewerClient
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'viewer.ts', path: 'viewer.ts', content: 'nope' });
    expect(fileWrite.status).toBe(403);
    expect(fileWrite.body.error.code).toBe('FORBIDDEN');

    const projectWrite = await viewerClient
      .patch(`/api/projects/${project.id}`)
      .send({ name: 'viewer-renamed' });
    expect(projectWrite.status).toBe(403);

    const inviteAttempt = await viewerClient
      .post(`/api/projects/${project.id}/invitations`)
      .send({ role: 'VIEWER' });
    expect(inviteAttempt.status).toBe(403);

    const members = await ownerClient.get(`/api/projects/${project.id}/members`);
    expect(members.body.data.map((member: { userId: string }) => member.userId))
      .toEqual(expect.arrayContaining([owner.user.id, viewer.user.id]));
  }, 30000);

  it('locks email invitations to the addressed account and accepts them from the dashboard', async () => {
    const owner = await newSession('team_owner');
    const invitee = await newSession('team_invitee');
    const other = await newSession('team_other');
    const project = await createProject(owner, 'email');

    const created = await createInvitation(
      owner,
      project.id,
      invitee.user.email.toUpperCase(),
      'EDITOR',
    );
    expect(created.invitation.email).toBe(invitee.user.email);

    const otherPreview = await csrfClient(other)
      .post('/api/invitations/preview')
      .send({ token: created.token });
    expect(otherPreview.status).toBe(403);
    expect(otherPreview.body.error.code).toBe('INVITATION_FORBIDDEN');

    const otherAccept = await csrfClient(other)
      .post('/api/invitations/accept')
      .send({ token: created.token });
    expect(otherAccept.status).toBe(403);

    const otherAcceptById = await csrfClient(other)
      .post(`/api/invitations/${created.invitation.id}/accept`)
      .send({});
    expect(otherAcceptById.status).toBe(403);

    const preview = await csrfClient(invitee)
      .post('/api/invitations/preview')
      .send({ token: created.token });
    expect(preview.status).toBe(200);
    expect(preview.body.data.currentRole).toBeNull();

    const accepted = await csrfClient(invitee)
      .post(`/api/invitations/${created.invitation.id}/accept`)
      .send({});
    expect(accepted.status).toBe(200);
    expect(accepted.body.data).toMatchObject({ role: 'EDITOR', alreadyMember: false });

    const acceptedAgain = await csrfClient(invitee)
      .post(`/api/invitations/${created.invitation.id}/accept`)
      .send({});
    expect(acceptedAgain.status).toBe(404);
    expect(acceptedAgain.body.error.code).toBe('INVITATION_INVALID');
  }, 30000);

  it('supports shareable-link invitations without exposing token material', async () => {
    const owner = await newSession('team_owner');
    const linkUser = await newSession('team_link');
    const project = await createProject(owner, 'link');
    const ownerClient = csrfClient(owner);

    const createdResponse = await ownerClient
      .post(`/api/projects/${project.id}/invitations`)
      .send({ role: 'EDITOR', expiresInDays: 3 });
    expect(createdResponse.status).toBe(201);
    expect(createdResponse.body.data.invitation.email).toBeNull();

    const created = createdResponse.body.data as InvitationPayload;

    const list = await ownerClient.get(`/api/projects/${project.id}/invitations`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(created.token);
    expect(list.body.data[0]).not.toHaveProperty('tokenHash');

    const linkClient = csrfClient(linkUser);
    const preview = await linkClient
      .post('/api/invitations/preview')
      .send({ token: created.token });
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({ role: 'EDITOR', alreadyMember: false });

    // Dashboard acceptance requires an addressed email; link tokens must be
    // redeemed through the token endpoint.
    const acceptById = await linkClient
      .post(`/api/invitations/${created.invitation.id}/accept`)
      .send({});
    expect(acceptById.status).toBe(403);

    const accepted = await linkClient
      .post('/api/invitations/accept')
      .send({ token: created.token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data).toMatchObject({ role: 'EDITOR', alreadyMember: false });

    const reuse = await linkClient
      .post('/api/invitations/accept')
      .send({ token: created.token });
    expect(reuse.status).toBe(404);
  }, 30000);

  it('rejects expired and revoked invitations, and cannot revoke accepted ones', async () => {
    const owner = await newSession('team_owner');
    const expiredInvitee = await newSession('team_expired');
    const revokedInvitee = await newSession('team_revoked');
    const acceptedInvitee = await newSession('team_accepted');
    const project = await createProject(owner, 'expiry');
    const ownerClient = csrfClient(owner);

    const expiring = await createInvitation(owner, project.id, expiredInvitee.user.email, 'VIEWER');
    await prisma.projectInvitation.update({
      where: { id: expiring.invitation.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const expiredPreview = await csrfClient(expiredInvitee)
      .post('/api/invitations/preview')
      .send({ token: expiring.token });
    expect(expiredPreview.status).toBe(404);

    const expiredAccept = await csrfClient(expiredInvitee)
      .post('/api/invitations/accept')
      .send({ token: expiring.token });
    expect(expiredAccept.status).toBe(404);

    const expiredInbox = await csrfClient(expiredInvitee).get('/api/invitations/mine');
    expect(expiredInbox.body.data.map((item: { id: string }) => item.id))
      .not.toContain(expiring.invitation.id);

    const revocable = await createInvitation(owner, project.id, revokedInvitee.user.email, 'VIEWER');
    const revoked = await ownerClient.delete(
      `/api/projects/${project.id}/invitations/${revocable.invitation.id}`,
    );
    expect(revoked.status).toBe(204);

    const listed = await ownerClient.get(`/api/projects/${project.id}/invitations`);
    const revokedRow = listed.body.data.find(
      (item: { id: string }) => item.id === revocable.invitation.id,
    );
    expect(revokedRow.status).toBe('REVOKED');

    const revokedPreview = await csrfClient(revokedInvitee)
      .post('/api/invitations/preview')
      .send({ token: revocable.token });
    expect(revokedPreview.status).toBe(404);

    const revokedAccept = await csrfClient(revokedInvitee)
      .post('/api/invitations/accept')
      .send({ token: revocable.token });
    expect(revokedAccept.status).toBe(404);

    const revokeAgain = await ownerClient.delete(
      `/api/projects/${project.id}/invitations/${revocable.invitation.id}`,
    );
    expect(revokeAgain.status).toBe(204);

    const accepted = await createInvitation(owner, project.id, acceptedInvitee.user.email, 'VIEWER');
    const acceptedResponse = await csrfClient(acceptedInvitee)
      .post('/api/invitations/accept')
      .send({ token: accepted.token });
    expect(acceptedResponse.status).toBe(200);

    const revokeAccepted = await ownerClient.delete(
      `/api/projects/${project.id}/invitations/${accepted.invitation.id}`,
    );
    expect(revokeAccepted.status).toBe(409);
    expect(revokeAccepted.body.error.code).toBe('INVITATION_USED');
  }, 30000);

  it('allows editors to write files while limiting admins to lower roles', async () => {
    const owner = await newSession('team_owner');
    const editor = await newSession('team_editor');
    const secondAdmin = await newSession('team_admin2');
    const viewer = await newSession('team_newviewer');
    const project = await createProject(owner, 'roles');
    const ownerClient = csrfClient(owner);
    const editorClient = csrfClient(editor);

    await joinByInvitation(owner, project.id, editor, 'EDITOR');

    const createdFile = await editorClient
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'editor.ts', path: 'editor.ts', content: 'const allowed = true;\n' });
    expect(createdFile.status).toBe(201);

    const updatedFile = await editorClient
      .patch(`/api/projects/${project.id}/files/${createdFile.body.data.id}`)
      .send({ content: 'const allowed = false;\n' });
    expect(updatedFile.status).toBe(200);

    const editorInvite = await editorClient
      .post(`/api/projects/${project.id}/invitations`)
      .send({ email: viewer.user.email, role: 'VIEWER' });
    expect(editorInvite.status).toBe(403);

    const editorRename = await editorClient
      .patch(`/api/projects/${project.id}`)
      .send({ name: 'editor-renamed' });
    expect(editorRename.status).toBe(403);

    const promote = await ownerClient
      .patch(`/api/projects/${project.id}/members/${editor.user.id}`)
      .send({ role: 'ADMIN' });
    expect(promote.status).toBe(200);
    expect(promote.body.data.role).toBe('ADMIN');

    const adminRename = await editorClient
      .patch(`/api/projects/${project.id}`)
      .send({ name: `admin-renamed-${Date.now()}` });
    expect(adminRename.status).toBe(200);

    const adminInviteViewer = await editorClient
      .post(`/api/projects/${project.id}/invitations`)
      .send({ email: viewer.user.email, role: 'VIEWER' });
    expect(adminInviteViewer.status).toBe(201);

    const adminInviteAdmin = await editorClient
      .post(`/api/projects/${project.id}/invitations`)
      .send({ email: 'another-admin@example.test', role: 'ADMIN' });
    expect(adminInviteAdmin.status).toBe(403);

    await joinByInvitation(owner, project.id, secondAdmin, 'ADMIN');

    const adminDemotePeer = await editorClient
      .patch(`/api/projects/${project.id}/members/${secondAdmin.user.id}`)
      .send({ role: 'VIEWER' });
    expect(adminDemotePeer.status).toBe(403);
    expect(adminDemotePeer.body.error.code).toBe('FORBIDDEN');

    const adminChangeOwner = await editorClient
      .patch(`/api/projects/${project.id}/members/${owner.user.id}`)
      .send({ role: 'ADMIN' });
    expect(adminChangeOwner.status).toBe(403);
    expect(adminChangeOwner.body.error.code).toBe('OWNER_IMMUTABLE');

    const adminDelete = await editorClient.delete(`/api/projects/${project.id}`);
    expect(adminDelete.status).toBe(403);

    const ownerDemotesAdmin = await ownerClient
      .patch(`/api/projects/${project.id}/members/${editor.user.id}`)
      .send({ role: 'VIEWER' });
    expect(ownerDemotesAdmin.status).toBe(200);
    expect(ownerDemotesAdmin.body.data.role).toBe('VIEWER');

    const ownerRemovesAdmin = await ownerClient.delete(
      `/api/projects/${project.id}/members/${secondAdmin.user.id}`,
    );
    expect(ownerRemovesAdmin.status).toBe(204);

    const removedAdminAccess = await csrfClient(secondAdmin).get(`/api/projects/${project.id}`);
    expect(removedAdminAccess.status).toBe(404);

    const ownerRemovesViewer = await ownerClient.delete(
      `/api/projects/${project.id}/members/${editor.user.id}`,
    );
    expect(ownerRemovesViewer.status).toBe(204);

    const removedEditorAccess = await editorClient.get(`/api/projects/${project.id}`);
    expect(removedEditorAccess.status).toBe(404);
  }, 30000);

  it('returns 404 to non-members and lets members leave on their own', async () => {
    const owner = await newSession('team_owner');
    const member = await newSession('team_member');
    const outsider = await newSession('team_outsider');
    const project = await createProject(owner, 'privacy');
    const outsiderClient = csrfClient(outsider);
    const memberClient = csrfClient(member);
    const ownerClient = csrfClient(owner);

    await joinByInvitation(owner, project.id, member, 'VIEWER');

    const projectRead = await outsiderClient.get(`/api/projects/${project.id}`);
    expect(projectRead.status).toBe(404);

    const memberList = await outsiderClient.get(`/api/projects/${project.id}/members`);
    expect(memberList.status).toBe(404);

    const invitationList = await outsiderClient.get(`/api/projects/${project.id}/invitations`);
    expect(invitationList.status).toBe(404);

    const fileList = await outsiderClient.get(`/api/projects/${project.id}/files`);
    expect(fileList.status).toBe(404);

    const fileWrite = await outsiderClient
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'outsider.ts', path: 'outsider.ts', content: '' });
    expect(fileWrite.status).toBe(404);

    const leave = await memberClient.delete(`/api/projects/${project.id}/members/${member.user.id}`);
    expect(leave.status).toBe(204);

    const afterLeave = await memberClient.get(`/api/projects/${project.id}`);
    expect(afterLeave.status).toBe(404);

    const remaining = await ownerClient.get(`/api/projects/${project.id}/members`);
    expect(remaining.body.data.map((row: { userId: string }) => row.userId))
      .not.toContain(member.user.id);
  }, 30000);
});
