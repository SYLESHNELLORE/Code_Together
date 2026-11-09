import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { prisma } from '../../db/prisma.js';
import { csrfClient, registerTestUser, type TestSession } from './authTestUtils.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const integration = hasDatabase ? describe : describe.skip;

integration('project and file persistence (requires MySQL)', () => {
  const createdProjectIds: string[] = [];
  let session: TestSession;
  let client: ReturnType<typeof csrfClient>;

  beforeAll(async () => {
    session = await registerTestUser('persist');
    client = csrfClient(session);
  });

  afterAll(async () => {
    // Only remove rows created by this test run; never touch existing data.
    if (createdProjectIds.length > 0) {
      await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } });
    }
    if (session) {
      // Cascades to the test user's remaining projects, files and sessions.
      await prisma.user.deleteMany({ where: { id: session.user.id } });
    }
    await prisma.$disconnect();
  });

  async function createProject(name: string) {
    const response = await client
      .post('/api/projects')
      .send({ name, description: 'Integration test project' });

    expect(response.status).toBe(201);
    createdProjectIds.push(response.body.data.id);
    return response.body.data as { id: string; name: string; description: string; updatedAt: string };
  }

  it('serves a public health check', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('rejects invalid project payloads', async () => {
    const missingName = await client.post('/api/projects').send({ description: 'no name' });
    expect(missingName.status).toBe(400);
    expect(missingName.body.error.code).toBe('VALIDATION_ERROR');

    const blankName = await client.post('/api/projects').send({ name: '   ' });
    expect(blankName.status).toBe(400);
  });

  it('rejects malformed project IDs', async () => {
    const response = await client.get('/api/projects/not-a-uuid');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('creates, lists, reads, updates and deletes a project', async () => {
    const project = await createProject(`crud-${Date.now()}`);

    const list = await client.get('/api/projects');
    expect(list.status).toBe(200);
    expect(list.body.data.some((item: { id: string }) => item.id === project.id)).toBe(true);

    const fetched = await client.get(`/api/projects/${project.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.data.name).toBe(project.name);

    const updated = await client
      .patch(`/api/projects/${project.id}`)
      .send({ name: `${project.name}-renamed`, description: 'Updated description' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.name).toBe(`${project.name}-renamed`);
    expect(updated.body.data.description).toBe('Updated description');

    const missing = await client.patch('/api/projects/11111111-1111-4111-8111-111111111111').send({ name: 'nope' });
    expect(missing.status).toBe(404);

    const deleted = await client.delete(`/api/projects/${project.id}`);
    expect(deleted.status).toBe(204);

    const afterDelete = await client.get(`/api/projects/${project.id}`);
    expect(afterDelete.status).toBe(404);

    const deleteAgain = await client.delete(`/api/projects/${project.id}`);
    expect(deleteAgain.status).toBe(404);

    // Remove from cleanup list because the test already deleted it.
    createdProjectIds.splice(createdProjectIds.indexOf(project.id), 1);
  });

  it('persists file contents and enforces optimistic concurrency', async () => {
    const project = await createProject(`files-${Date.now()}`);

    const emptyList = await client.get(`/api/projects/${project.id}/files`);
    expect(emptyList.status).toBe(200);
    expect(emptyList.body.data).toEqual([]);

    const created = await client
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'index.ts', path: 'index.ts', language: 'typescript', content: 'const value = 1;\n' });
    expect(created.status).toBe(201);
    expect(created.body.data.content).toBe('const value = 1;\n');

    const file = created.body.data as { id: string; updatedAt: string };

    const duplicate = await client
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'index.ts', path: 'index.ts', content: '' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('CONFLICT');

    const read = await client.get(`/api/projects/${project.id}/files/${file.id}`);
    expect(read.status).toBe(200);
    expect(read.body.data.content).toBe('const value = 1;\n');

    const saved = await client
      .patch(`/api/projects/${project.id}/files/${file.id}`)
      .send({ content: 'const value = 2;\n', version: Date.parse(file.updatedAt) });
    expect(saved.status).toBe(200);
    expect(saved.body.data.content).toBe('const value = 2;\n');

    // Re-using the old revision must be rejected rather than overwriting.
    const stale = await client
      .patch(`/api/projects/${project.id}/files/${file.id}`)
      .send({ content: 'stale overwrite', version: Date.parse(file.updatedAt) });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT');

    const reloaded = await client.get(`/api/projects/${project.id}/files/${file.id}`);
    expect(reloaded.body.data.content).toBe('const value = 2;\n');

    const renamed = await client
      .patch(`/api/projects/${project.id}/files/${file.id}`)
      .send({ name: 'main.ts', path: 'main.ts', version: Date.parse(saved.body.data.updatedAt) });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.name).toBe('main.ts');

    const list = await client.get(`/api/projects/${project.id}/files`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].name).toBe('main.ts');
    // Folder listings are metadata-only; content is fetched per open file.
    expect(list.body.data[0]).not.toHaveProperty('content');

    const deletedFile = await client.delete(`/api/projects/${project.id}/files/${file.id}`);
    expect(deletedFile.status).toBe(204);

    const afterDelete = await client.get(`/api/projects/${project.id}/files/${file.id}`);
    expect(afterDelete.status).toBe(404);
  });

  it('rejects files that target a missing project', async () => {
    const response = await client
      .post('/api/projects/11111111-1111-4111-8111-111111111111/files')
      .send({ name: 'a.ts', path: 'a.ts', content: '' });
    expect(response.status).toBe(404);
  });

  it('validates file names, paths and empty updates', async () => {
    const project = await createProject(`validation-${Date.now()}`);

    const slashName = await client
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'nested/file.ts', path: 'nested/file.ts', content: '' });
    expect(slashName.status).toBe(400);
    expect(slashName.body.error.code).toBe('VALIDATION_ERROR');

    const traversalPath = await client
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'file.ts', path: '../file.ts', content: '' });
    expect(traversalPath.status).toBe(400);

    const mismatch = await client
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'file.ts', path: 'other.ts', content: '' });
    expect(mismatch.status).toBe(400);

    const created = await client
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'file.ts', path: 'file.ts', content: '' });
    expect(created.status).toBe(201);

    const emptyUpdate = await client
      .patch(`/api/projects/${project.id}/files/${created.body.data.id}`)
      .send({});
    expect(emptyUpdate.status).toBe(400);

    const emptyProjectUpdate = await client
      .patch(`/api/projects/${project.id}`)
      .send({});
    expect(emptyProjectUpdate.status).toBe(400);
  });

  it('creates folders, nests files and cascades folder renames/deletes', async () => {
    const project = await createProject(`folders-${Date.now()}`);

    const folder = await client
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'src', path: 'src', isFolder: true });
    expect(folder.status).toBe(201);
    expect(folder.body.data.isFolder).toBe(true);
    expect(folder.body.data.content).toBe('');

    const duplicate = await client
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'src', path: 'src', isFolder: true });
    expect(duplicate.status).toBe(409);

    const traversal = await client
      .post(`/api/projects/${project.id}/files`)
      .send({ name: '..', path: '..', isFolder: true });
    expect(traversal.status).toBe(400);

    const child = await client
      .post(`/api/projects/${project.id}/files`)
      .send({
        name: 'hello.js',
        path: 'src/hello.js',
        parentId: folder.body.data.id,
        language: 'javascript',
        content: 'console.log(1);\n',
      });
    expect(child.status).toBe(201);
    expect(child.body.data.parentId).toBe(folder.body.data.id);

    const wrongPath = await client
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'wrong.js', path: 'hello.js', parentId: folder.body.data.id });
    expect(wrongPath.status).toBe(400);

    const fileAsParent = await client
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'nested.js', path: 'src/hello.js/nested.js', parentId: child.body.data.id });
    expect(fileAsParent.status).toBe(400);

    const folderContent = await client
      .patch(`/api/projects/${project.id}/files/${folder.body.data.id}`)
      .send({ content: 'nope' });
    expect(folderContent.status).toBe(400);

    const renamed = await client
      .patch(`/api/projects/${project.id}/files/${folder.body.data.id}`)
      .send({ name: 'lib', version: Date.parse(folder.body.data.updatedAt) });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.path).toBe('lib');

    // Moving a file to another folder is path-derived on the server.
    const destination = await client
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'other', path: 'other', isFolder: true });
    expect(destination.status).toBe(201);

    const moved = await client
      .patch(`/api/projects/${project.id}/files/${child.body.data.id}`)
      .send({ parentId: destination.body.data.id });
    expect(moved.status).toBe(200);
    expect(moved.body.data.path).toBe('other/hello.js');
    expect(moved.body.data.parentId).toBe(destination.body.data.id);

    // Moving a folder into its own descendant must be rejected.
    const cycle = await client
      .patch(`/api/projects/${project.id}/files/${folder.body.data.id}`)
      .send({ parentId: folder.body.data.id });
    expect(cycle.status).toBe(400);

    const list = await client.get(`/api/projects/${project.id}/files`);
    expect(list.status).toBe(200);
    const renamedChild = list.body.data.find((item: { id: string }) => item.id === child.body.data.id);
    expect(renamedChild.path).toBe('other/hello.js');

    const deletedFolder = await client.delete(`/api/projects/${project.id}/files/${folder.body.data.id}`);
    expect(deletedFolder.status).toBe(204);

    // The moved file survives deletion of its original parent folder.
    const afterDelete = await client.get(`/api/projects/${project.id}/files`);
    expect(afterDelete.body.data.map((item: { id: string }) => item.id))
      .toEqual(expect.arrayContaining([destination.body.data.id, child.body.data.id]));
    expect(afterDelete.body.data.some((item: { id: string }) => item.id === folder.body.data.id)).toBe(false);
  });

  it('moves folders with their descendants and rejects conflicting destinations', async () => {
    const project = await createProject(`move-${Date.now()}`);

    const source = await client
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'src', path: 'src', isFolder: true });
    const target = await client
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'packages', path: 'packages', isFolder: true });
    const nested = await client
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'app', path: 'src/app', parentId: source.body.data.id, isFolder: true });
    const file = await client
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'index.ts', path: 'src/app/index.ts', parentId: nested.body.data.id, content: 'export {};\n' });
    expect(source.status).toBe(201);
    expect(target.status).toBe(201);
    expect(nested.status).toBe(201);
    expect(file.status).toBe(201);

    const moved = await client
      .patch(`/api/projects/${project.id}/files/${source.body.data.id}`)
      .send({ parentId: target.body.data.id, version: Date.parse(source.body.data.updatedAt) });
    expect(moved.status).toBe(200);
    expect(moved.body.data.path).toBe('packages/src');

    const afterMove = await client.get(`/api/projects/${project.id}/files`);
    const paths = afterMove.body.data.map((item: { path: string }) => item.path).sort();
    expect(paths).toEqual(['packages', 'packages/src', 'packages/src/app', 'packages/src/app/index.ts']);

    // Moving onto an occupied path is a conflict, not a silent overwrite.
    const duplicate = await client
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'app', path: 'packages/app', parentId: target.body.data.id, isFolder: true });
    expect(duplicate.status).toBe(201);

    const conflict = await client
      .patch(`/api/projects/${project.id}/files/${duplicate.body.data.id}`)
      .send({ parentId: source.body.data.id });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('CONFLICT');

    // The client cannot smuggle in a path that disagrees with the destination.
    const forgedPath = await client
      .patch(`/api/projects/${project.id}/files/${file.body.data.id}`)
      .send({ name: 'escape.ts', path: '../escape.ts', parentId: null });
    expect(forgedPath.status).toBe(400);
  });

  it('accepts large source files up to the API limit and rejects oversized content', async () => {
    const project = await createProject(`large-${Date.now()}`);

    // Larger than MySQL TEXT's 64 KiB capacity.
    const largeContent = `// ${'x'.repeat(70_000)}\nconst value = 1;\n`;
    const created = await client
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'large.ts', path: 'large.ts', content: largeContent });
    expect(created.status).toBe(201);

    const read = await client.get(`/api/projects/${project.id}/files/${created.body.data.id}`);
    expect(read.status).toBe(200);
    expect(read.body.data.content).toBe(largeContent);

    const oversized = await client
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'huge.ts', path: 'huge.ts', content: 'x'.repeat(1_000_001) });
    expect(oversized.status).toBe(400);
    expect(oversized.body.error.code).toBe('VALIDATION_ERROR');

    const oversizedUpdate = await client
      .patch(`/api/projects/${project.id}/files/${created.body.data.id}`)
      .send({ content: 'x'.repeat(1_000_001) });
    expect(oversizedUpdate.status).toBe(400);
  });

  it('searches file names and paths without returning content', async () => {
    const project = await createProject(`search-${Date.now()}`);

    await client
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'searchable.ts', path: 'searchable.ts', content: 'hidden' });
    await client
      .post(`/api/projects/${project.id}/files`)
      .send({ name: 'ignored.ts', path: 'ignored.ts', content: 'hidden' });

    const result = await client.get(`/api/projects/${project.id}/files?search=searchable`);
    expect(result.status).toBe(200);
    expect(result.body.data).toHaveLength(1);
    expect(result.body.data[0].name).toBe('searchable.ts');
    expect(result.body.data[0]).not.toHaveProperty('content');
  });
});
