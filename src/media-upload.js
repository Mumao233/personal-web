// Shared transport for the rich editor, photo workbench and PDF attachments.
// One file per request gives each queue item progress, retry and cancellation.
export function uploadMedia(file, onProgress = () => {}, onRequest = () => {}) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    onRequest(request);
    request.open("POST", "/api/admin/upload");
    request.responseType = "json";
    request.timeout = 120000;
    request.upload.onprogress = (event) => {
      if (event.lengthComputable)
        onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      if (request.status < 200 || request.status >= 300)
        return reject(
          new Error(
            request.response?.error ||
              `文件上传失败（${request.status}），请重试`,
          ),
        );
      const file = request.response?.files?.[0];
      if (!file?.url) reject(new Error("服务器未接收此文件，请检查文件格式"));
      else resolve(file);
    };
    request.onerror = () => reject(new Error("网络连接中断，请重试"));
    request.ontimeout = () => reject(new Error("文件上传超时，请重试"));
    request.onabort = () => reject(new Error("上传已取消"));
    const data = new FormData();
    const extensions = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif",
      "application/pdf": "pdf",
    };
    const filename = /\.(jpe?g|png|webp|gif|pdf)$/i.test(file.name)
      ? file.name
      : `media-${Date.now()}.${extensions[file.type] || "png"}`;
    data.append("files", file, filename);
    request.send(data);
  });
}
