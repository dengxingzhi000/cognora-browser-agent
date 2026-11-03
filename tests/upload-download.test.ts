import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createAndWait, createBrowserRuntime, type BrowserRuntime } from './helpers/browser-runtime.js';

function runtimePayload(runtime: BrowserRuntime, actions: unknown[]) {
  return {
    taskType: 'actions.run',
    tenantId: 'tenant-files',
    userId: 'u1',
    target: { system: 'fixture', url: runtime.fixture.url },
    executionMode: 'auto',
    input: { actions },
  };
}

function writeUploadFile(runtime: BrowserRuntime, name: string, content: string): string {
  fs.mkdirSync(runtime.config.uploadRoot, { recursive: true });
  const filePath = path.join(runtime.config.uploadRoot, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

test('文件上传 / 下载：setInputFiles、落盘、扩展名与大小校验', { timeout: 180000 }, async () => {
  const runtime = await createBrowserRuntime();
  try {
    const base = runtime.fixture.url;
    const receipt = writeUploadFile(runtime, 'receipt.txt', 'hello upload');

    const upload = await createAndWait(
      runtime,
      runtimePayload(runtime, [
        {
          action: 'goto',
          url: `${base}/components/upload`,
          expect: { type: 'text', text: '文件上传', exact: false },
        },
        {
          action: 'upload',
          target: { by: 'label', name: '选择文件' },
          files: [receipt],
        },
        {
          action: 'click',
          target: { role: 'button', name: '解析文件' },
          expect: { type: 'status', text: '已接收 receipt.txt', exact: false },
        },
      ])
    );

    assert.equal(upload.status, 'COMPLETED', JSON.stringify(upload.steps));
    const uploadValidation = upload.steps[1].validations.find(
      (item) => item.kind === 'file-selected'
    );
    assert.ok(uploadValidation?.ok, JSON.stringify(upload.steps[1].validations));
    assert.match(uploadValidation.actual ?? '', /receipt\.txt/);
    assert.equal(upload.steps[2].validations[0].ok, true);

    const download = await createAndWait(
      runtime,
      runtimePayload(runtime, [
        {
          action: 'goto',
          url: `${base}/components/download`,
          expect: { type: 'text', text: '文件下载', exact: false },
        },
        {
          action: 'download',
          target: { role: 'link', name: '下载对账单' },
          saveAs: 'report.csv',
        },
      ])
    );

    assert.equal(download.status, 'COMPLETED', JSON.stringify(download.steps));
    const downloadValidation = download.steps[1].validations.find(
      (item) => item.kind === 'download'
    );
    assert.ok(downloadValidation?.ok, JSON.stringify(download.steps[1].validations));
    assert.match(downloadValidation.actual ?? '', /report\.csv/);
    assert.ok(downloadValidation.detail);
    assert.equal(fs.existsSync(downloadValidation.detail), true);
    assert.ok(fs.statSync(downloadValidation.detail!).size > 0);
  } finally {
    await runtime.shutdown();
  }
});

test('文件上传：扩展名与大小超限在上传前拒绝', { timeout: 180000 }, async () => {
  const runtime = await createBrowserRuntime();
  try {
    const base = runtime.fixture.url;
    const exe = writeUploadFile(runtime, 'malware.exe', 'not allowed');
    const huge = writeUploadFile(
      runtime,
      'huge.txt',
      'x'.repeat(runtime.config.uploadMaxBytes + 1)
    );

    for (const [file, reason] of [
      [exe, 'extension'],
      [huge, 'size'],
    ] as Array<[string, string]>) {
      const task = await createAndWait(
        runtime,
        runtimePayload(runtime, [
          {
            action: 'goto',
            url: `${base}/components/upload`,
            expect: { type: 'text', text: '文件上传', exact: false },
          },
          {
            action: 'upload',
            target: { by: 'label', name: '选择文件' },
            files: [file],
          },
        ])
      );

      assert.equal(task.status, 'FAILED', `${reason}: ${JSON.stringify(task.steps)}`);
      assert.equal(task.steps[1].error?.code, 'UPLOAD_REJECTED');
      assert.equal(task.error?.code, 'UPLOAD_REJECTED');
    }
  } finally {
    await runtime.shutdown();
  }
});
