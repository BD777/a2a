import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const IMAGE_MIME_BY_EXT = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);

const IMAGE_EXT_BY_MIME = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
]);

export class FeishuAttachmentDownloader {
  constructor({ clients, config, logger }) {
    this.clients = clients;
    this.config = config;
    this.logger = logger;
  }

  async resolve(appId, attachments) {
    const list = Array.isArray(attachments) ? attachments : [];
    if (list.length === 0) return list;
    if (!this.config.attachmentsEnabled) {
      return list.map((item) => (item?.kind === 'image' ? { ...item, error: 'attachments disabled' } : item));
    }

    let imageCount = 0;
    const resolved = [];
    for (const attachment of list) {
      if (attachment?.kind !== 'image') {
        resolved.push(attachment);
        continue;
      }
      imageCount += 1;
      if (imageCount > this.config.attachmentImageLimit) {
        resolved.push({ ...attachment, error: `image limit ${this.config.attachmentImageLimit} exceeded` });
        continue;
      }
      resolved.push(await this.resolveImage(appId, attachment));
    }
    return resolved;
  }

  async resolveImage(appId, attachment) {
    if (!attachment?.messageId || !attachment?.fileKey) {
      return { ...attachment, error: 'missing message_id or file_key' };
    }
    try {
      return await this.downloadImage(appId, attachment);
    } catch (err) {
      const message = err?.message || String(err);
      this.logger.warn(`Feishu image download skipped message=${attachment.messageId}: ${message}`);
      return { ...attachment, error: message };
    }
  }

  async downloadImage(appId, attachment) {
    const dir = join(
      this.config.attachmentsDir,
      safeSegment(appId),
      safeSegment(attachment.messageId),
    );
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const baseName = `${safeSegment(attachment.messageId)}-${hashKey(attachment.fileKey)}`;
    const basePath = join(dir, baseName);
    const cached = cachedImage(basePath);
    if (cached) return { ...attachment, ...cached };

    const resource = await this.clients.getMessageResource(appId, {
      messageId: attachment.messageId,
      fileKey: attachment.fileKey,
      type: attachment.resourceType || 'image',
    });

    const contentLength = numberHeader(resource.headers, 'content-length');
    const maxBytes = Number(this.config.attachmentMaxBytes || 0);
    if (maxBytes > 0 && contentLength > maxBytes) {
      destroyResource(resource);
      throw new Error(`image is ${contentLength} bytes, over ${maxBytes} byte limit`);
    }

    const tmpPath = `${basePath}.download`;
    rmSync(tmpPath, { force: true });
    await resource.writeFile(tmpPath);
    chmodSync(tmpPath, 0o600);

    const sizeBytes = statSync(tmpPath).size;
    if (maxBytes > 0 && sizeBytes > maxBytes) {
      unlinkSync(tmpPath);
      throw new Error(`image is ${sizeBytes} bytes, over ${maxBytes} byte limit`);
    }

    const mimeType = supportedImageMime(
      headerValue(resource.headers, 'content-type')
      || sniffImageMime(tmpPath)
      || mimeFromFileName(attachment.fileName),
    );
    if (!mimeType) {
      unlinkSync(tmpPath);
      throw new Error('unsupported image type');
    }

    const localPath = `${basePath}${IMAGE_EXT_BY_MIME.get(mimeType)}`;
    if (existsSync(localPath)) unlinkSync(tmpPath);
    else renameSync(tmpPath, localPath);
    chmodSync(localPath, 0o600);
    return { ...attachment, localPath, mimeType, sizeBytes };
  }
}

export function usableImageAttachments(attachments = []) {
  const images = [];
  for (const item of Array.isArray(attachments) ? attachments : []) {
    if (item?.kind !== 'image' || !item.localPath || !existsSync(item.localPath)) continue;
    const mimeType = supportedImageMime(item.mimeType)
      || mimeFromFileName(item.localPath)
      || safeSniffImageMime(item.localPath);
    if (supportedImageMime(mimeType)) images.push({ ...item, mimeType });
  }
  return images;
}

export function supportedImageMime(value) {
  const mime = String(value || '').split(';')[0].trim().toLowerCase();
  return IMAGE_EXT_BY_MIME.has(mime) ? mime : '';
}

function cachedImage(basePath) {
  for (const [ext, mimeType] of IMAGE_MIME_BY_EXT.entries()) {
    const localPath = `${basePath}${ext}`;
    if (!existsSync(localPath)) continue;
    const sizeBytes = statSync(localPath).size;
    if (sizeBytes > 0) return { localPath, mimeType, sizeBytes };
  }
  return null;
}

function headerValue(headers, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  const value = headers[lower] || headers[name] || Object.entries(headers)
    .find(([key]) => key.toLowerCase() === lower)?.[1];
  return Array.isArray(value) ? value[0] : String(value || '');
}

function numberHeader(headers, name) {
  const value = Number(headerValue(headers, name));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function mimeFromFileName(fileName) {
  const lower = String(fileName || '').toLowerCase();
  for (const [ext, mime] of IMAGE_MIME_BY_EXT.entries()) {
    if (lower.endsWith(ext)) return mime;
  }
  return '';
}

function sniffImageMime(filePath) {
  const fd = openSync(filePath, 'r');
  const buffer = Buffer.alloc(12);
  try {
    const n = readSync(fd, buffer, 0, buffer.length, 0);
    if (n >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (n >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (n >= 6 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif';
    if (n >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    return '';
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

function safeSniffImageMime(filePath) {
  try {
    return sniffImageMime(filePath);
  } catch {
    return '';
  }
}

function destroyResource(resource) {
  try {
    const stream = resource.getReadableStream();
    if (stream?.destroy) stream.destroy();
  } catch {
    // Ignore cleanup failures; the original size error is more useful.
  }
}

function safeSegment(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96) || 'unknown';
}

function hashKey(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24);
}
