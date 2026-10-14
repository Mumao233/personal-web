import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { normalizeDocument, documentText } from "../server/content.js";

let child, dir, cookie, base;
const paragraph = (text) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const article = (text) => ({ type: "doc", content: [paragraph(text)] });
async function call(path, method = "GET", body, authenticated = true) {
  const response = await fetch(base + "/api" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(authenticated && cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json(), response };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "personal-space-rich-test-"));
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server/index.js", "--production"], {
    env: {
      ...process.env,
      DATA_DIR: dir,
      PORT: String(port),
      TEST_MODE: "1",
      ATLAS_ENABLED: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let log = "";
    const timeout = setTimeout(
      () => reject(Error("Article server did not start: " + log)),
      15000,
    );
    child.stderr.on("data", (chunk) => {
      log += chunk.toString();
    });
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("Personal Space:")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(Error(`Article server exited ${code}: ${log}`));
    });
  });
  const setup = await call(
    "/setup",
    "POST",
    { username: "rich-test-admin", password: "rich-content-testing-123" },
    false,
  );
  assert.equal(setup.status, 200);
  cookie = setup.response.headers.get("set-cookie").split(";")[0];
});
after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("structured documents retain allowed typography and image layouts without arbitrary HTML attributes", () => {
  const doc = normalizeDocument({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2, onclick: "bad" },
        content: [{ type: "text", text: "Heading", marks: [{ type: "bold" }] }],
      },
      {
        type: "image",
        attrs: {
          src: "/uploads/landscape.jpg",
          caption: "My photograph",
          align: "left",
          width: 50,
          onerror: "bad",
          style: "bad",
        },
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Article link",
            marks: [
              {
                type: "link",
                attrs: { href: "https://example.com/story", onclick: "bad" },
              },
            ],
          },
          { type: "hardBreak", marks: [{ type: "bold" }] },
          { type: "text", text: "Next line" },
        ],
      },
      {
        type: "orderedList",
        attrs: { start: 3 },
        content: [{ type: "listItem", content: [paragraph("List item")] }],
      },
    ],
  });
  assert.equal(doc.content[1].attrs.width, 50);
  assert.equal(doc.content[1].attrs.align, "left");
  assert.equal(doc.content[1].attrs.onerror, undefined);
  assert.equal(doc.content[1].attrs.style, undefined);
  assert.equal(doc.content[0].attrs.onclick, undefined);
  assert.match(
    documentText(doc),
    /Heading\n\nMy photograph\n\nArticle link\nNext line\n\nList item/,
  );
  assert.equal(
    doc.content[2].content[0].marks[0].attrs.rel,
    "noopener noreferrer nofollow",
  );
});

test("invalid rich content rejects scripts, external images, traversal and malformed nesting", () => {
  for (const src of [
    "javascript:alert(1)",
    "data:image/svg+xml,bad",
    "https://example.com/photo.png",
    "//example.com/photo.png",
    "/uploads/../private.png",
    "/uploads/%2e%2e/private.png",
    "/uploads/a.svg",
    "/uploads/a.pdf",
  ]) {
    assert.throws(
      () =>
        normalizeDocument({
          type: "doc",
          content: [{ type: "image", attrs: { src } }],
        }),
      /图片/,
    );
  }
  for (const href of [
    "javascript:alert(1)",
    "data:text/html,bad",
    "//example.com",
    "https://user:password@example.com",
    "https://exa\nmple.com",
  ]) {
    assert.throws(
      () =>
        normalizeDocument({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "unsafe",
                  marks: [{ type: "link", attrs: { href } }],
                },
              ],
            },
          ],
        }),
      /链接/,
    );
  }
  assert.throws(
    () =>
      normalizeDocument({
        type: "doc",
        content: [{ type: "html", text: "<script>bad</script>" }],
      }),
    /节点/,
  );
  assert.throws(
    () =>
      normalizeDocument({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "image", attrs: { src: "/uploads/a.png" } }],
          },
        ],
      }),
    /节点/,
  );
  assert.throws(
    () =>
      normalizeDocument({
        type: "doc",
        content: [{ type: "heading", attrs: { level: 1 } }],
      }),
    /标题/,
  );
  assert.throws(
    () =>
      normalizeDocument({
        type: "doc",
        content: [{ type: "bulletList", content: [paragraph("wrong child")] }],
      }),
    /节点/,
  );
});

test("new untitled draft stays private and metadata injection cannot publish it", async () => {
  assert.equal(
    (await call("/admin/posts/new/draft", "PUT", { revision: 0 }, false))
      .status,
    401,
  );
  const saved = await call("/admin/posts/new/draft", "PUT", {
    revision: 0,
    title: "",
    content: article("PRIVATE DRAFT"),
    body: "spoofed summary",
    published: true,
    id: "injected-id",
    draft: { title: "injected" },
    createdAt: "spoofed",
  });
  assert.equal(saved.status, 200);
  assert.notEqual(saved.data.id, "injected-id");
  assert.equal(saved.data.revision, 1);
  assert.equal(saved.data.published, false);
  assert.equal(saved.data.draft.body, "PRIVATE DRAFT");
  assert.equal(saved.data.draft.published, undefined);
  assert.equal(saved.data.draft.draft, undefined);
  assert.equal(
    JSON.stringify((await call("/public")).data).includes("PRIVATE DRAFT"),
    false,
  );
  assert.equal(
    (
      await call(`/admin/posts/${saved.data.id}/publish`, "POST", {
        revision: 1,
      })
    ).status,
    400,
  );
});

test("each content kind keeps its live version until publish and rejects stale saves", async () => {
  for (const kind of ["projects", "posts", "stories"]) {
    const detail =
      kind === "stories"
        ? {
            locationPrecision: "exact",
            lat: 23,
            lng: 113,
            confirmLocation: true,
            photos: ["/uploads/story.png"],
            location: "Guangzhou",
          }
        : {};
    const saved = await call(`/admin/${kind}/new/draft`, "PUT", {
      revision: 0,
      title: "Version one",
      content: article("LIVE ORIGINAL"),
      ...detail,
    });
    assert.equal(saved.status, 200);
    const id = saved.data.id;
    const published = await call(`/admin/${kind}/${id}/publish`, "POST", {
      revision: 1,
    });
    assert.equal(published.status, 200);
    assert.equal(published.data.revision, 2);
    assert.equal(published.data.draft, undefined);
    const pending = await call(`/admin/${kind}/${id}/draft`, "PUT", {
      revision: 2,
      title: "Version two",
      content: article("PRIVATE REPLACEMENT"),
    });
    assert.equal(pending.status, 200);
    assert.equal(pending.data.revision, 3);
    assert.equal(pending.data.body, "LIVE ORIGINAL");
    assert.equal(pending.data.updatedAt, published.data.updatedAt);
    const publicRecord = (await call("/public")).data[kind].find(
      (x) => x.id === id,
    );
    assert.equal(publicRecord.title, "Version one");
    assert.equal(publicRecord.body, "LIVE ORIGINAL");
    assert.equal(publicRecord.draft, undefined);
    assert.equal(publicRecord.revision, undefined);
    assert.equal(publicRecord.draftSavedAt, undefined);
    assert.equal(
      JSON.stringify(publicRecord).includes("PRIVATE REPLACEMENT"),
      false,
    );
    assert.equal(
      (
        await call(`/admin/${kind}/${id}/draft`, "PUT", {
          revision: 2,
          title: "stale",
        })
      ).status,
      409,
    );
    assert.equal(
      (await call(`/admin/${kind}/${id}/publish`, "POST", { revision: 2 }))
        .status,
      409,
    );
    const replacement = await call(`/admin/${kind}/${id}/publish`, "POST", {
      revision: 3,
    });
    assert.equal(replacement.status, 200);
    assert.equal(replacement.data.revision, 4);
    const nextPublic = (await call("/public")).data[kind].find(
      (x) => x.id === id,
    );
    assert.equal(nextPublic.body, "PRIVATE REPLACEMENT");
    if (kind === "stories") assert.deepEqual(nextPublic.photos, detail.photos);
    assert.equal(
      (await call(`/admin/${kind}/${id}/unpublish`, "POST", { revision: 3 }))
        .status,
      409,
    );
    const unpublished = await call(`/admin/${kind}/${id}/unpublish`, "POST", {
      revision: 4,
    });
    assert.equal(unpublished.data.revision, 5);
    assert.equal(
      (await call("/public")).data[kind].some((x) => x.id === id),
      false,
    );
  }
});

test("draft accepts incomplete location and link while publication validates them", async () => {
  const story = await call("/admin/stories/new/draft", "PUT", {
    revision: 0,
    title: "A location draft",
    lat: "",
    lng: "",
    confirmLocation: false,
  });
  assert.equal(story.status, 200);
  assert.equal(
    (
      await call(`/admin/stories/${story.data.id}/publish`, "POST", {
        revision: 1,
      })
    ).status,
    400,
  );
  const located = await call(`/admin/stories/${story.data.id}/draft`, "PUT", {
    revision: 1,
    lat: 23,
    lng: 113,
  });
  assert.equal(located.status, 200);
  assert.equal(
    (
      await call(`/admin/stories/${story.data.id}/publish`, "POST", {
        revision: 2,
      })
    ).status,
    400,
  );
  const project = await call("/admin/projects/new/draft", "PUT", {
    revision: 0,
    title: "A link draft",
    link: "javascript:alert(1)",
  });
  assert.equal(project.status, 200);
  assert.equal(
    (
      await call(`/admin/projects/${project.data.id}/publish`, "POST", {
        revision: 1,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("/admin/posts/new/draft", "PUT", {
        revision: 0,
        content: { type: "doc", content: [{ type: "rawHTML" }] },
      })
    ).status,
    400,
  );
});

test("null documents are rejected without altering saved content and an empty document can be published", async () => {
  const saved = await call("/admin/posts/new/draft", "PUT", {
    revision: 0,
    title: "Clear rich text",
    content: article("Original rich text"),
  });
  const id = saved.data.id;
  assert.equal(
    (await call(`/admin/posts/${id}/publish`, "POST", { revision: 1 })).status,
    200,
  );
  const rejected = await call(`/admin/posts/${id}/draft`, "PUT", {
    revision: 2,
    content: null,
    body: "Cannot replace the document implicitly",
  });
  assert.equal(rejected.status, 400);
  const unchanged = (await call("/admin")).data.posts.find(
    (post) => post.id === id,
  );
  assert.equal(unchanged.revision, 2);
  assert.equal(unchanged.body, "Original rich text");
  assert.equal(unchanged.draft, undefined);
  const cleared = await call(`/admin/posts/${id}/draft`, "PUT", {
    revision: 2,
    content: { type: "doc", content: [{ type: "paragraph" }] },
  });
  assert.equal(cleared.status, 200);
  assert.equal(
    (await call(`/admin/posts/${id}/publish`, "POST", { revision: 3 })).status,
    200,
  );
  const live = (await call("/public")).data.posts.find(
    (post) => post.id === id,
  );
  assert.equal(live.body, "");
  assert.deepEqual(live.content, {
    type: "doc",
    content: [{ type: "paragraph", content: [] }],
  });
});

test("legacy plain text and media survive editing, and deleted drafts cannot be revived by a stale request", async () => {
  const legacy = await call("/admin/stories/new", "PUT", {
    title: "Old story",
    locationPrecision: "exact",
    confirmLocation: true,
    body: "Old plain text\n\nSecond paragraph",
    photos: ["/uploads/old.jpg"],
    cover: "/uploads/cover.jpg",
    city: "Guangzhou",
    location: "Saved place",
    lat: 23,
    lng: 113,
    published: true,
  });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.data.content, undefined);
  const saved = await call(`/admin/stories/${legacy.data.id}/draft`, "PUT", {
    revision: legacy.data.revision,
    title: "Edited title",
  });
  assert.equal(saved.data.draft.body, legacy.data.body);
  assert.deepEqual(saved.data.draft.photos, legacy.data.photos);
  assert.equal(saved.data.draft.cover, legacy.data.cover);
  assert.equal(saved.data.draft.location, legacy.data.location);
  assert.equal(saved.data.title, "Old story");
  assert.equal(
    (await call(`/admin/stories/${legacy.data.id}`, "DELETE")).status,
    200,
  );
  assert.equal(
    (
      await call(`/admin/stories/${legacy.data.id}/draft`, "PUT", {
        revision: saved.data.revision,
        title: "stale",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await call(`/admin/stories/${legacy.data.id}/publish`, "POST", {
        revision: saved.data.revision,
      })
    ).status,
    404,
  );
});
