import { mapWordPressExport, type WordPressConversion } from "./map.js";
import { emptyExport } from "./model.js";
import { collect, looksLikeWxr, WxrReader } from "./wxr.js";

/**
 * An import body as it streams in, whichever it is: a Writavo Import Format document (JSON) or a
 * WordPress export file (WXR). The first few kilobytes decide. JSON is read whole, to the JSON
 * ceiling, exactly as before; WXR is parsed AS IT ARRIVES (the raw XML is never held whole) and
 * converted, so an export can be several times the size of the document it becomes.
 */

/** The largest WordPress export read. The document it becomes must still fit the job's 10 MB. */
export const MAX_WXR_BYTES = 100 * 1024 * 1024;
const SNIFF_CHARS = 4096;

export type ReadImportBody =
  | { kind: "json"; text: string }
  | { kind: "wxr"; conversion: WordPressConversion; bytes: number }
  | { kind: "too_large"; limitBytes: number; wxr: boolean }
  | { kind: "error"; message: string };

export async function readImportBody(stream: ReadableStream<Uint8Array>, maxJsonBytes: number, now = Date.now()): Promise<ReadImportBody> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let head = "";
  let total = 0;
  let done = false;
  // Enough of the start to tell the two apart.
  while (!done && head.length < SNIFF_CHARS) {
    const next = await reader.read();
    if (next.done) {
      done = true;
      break;
    }
    total += next.value.byteLength;
    head += decoder.decode(next.value, { stream: true });
  }

  if (!looksLikeWxr(head)) {
    let text = head;
    while (!done) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxJsonBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: "too_large", limitBytes: maxJsonBytes, wxr: false };
      }
      text += decoder.decode(next.value, { stream: true });
    }
    if (total > maxJsonBytes) return { kind: "too_large", limitBytes: maxJsonBytes, wxr: false };
    return { kind: "json", text: text + decoder.decode() };
  }

  const exp = emptyExport();
  const wxr = new WxrReader((record) => collect(exp, record));
  try {
    wxr.write(head);
    while (!done) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_WXR_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { kind: "too_large", limitBytes: MAX_WXR_BYTES, wxr: true };
      }
      wxr.write(decoder.decode(next.value, { stream: true }));
    }
    wxr.write(decoder.decode());
    wxr.end();
  } catch (err) {
    return { kind: "error", message: `The WordPress export file could not be read: ${err instanceof Error ? err.message : String(err)}.` };
  }
  if (exp.items.length === 0 && wxr.errorCount > 0) {
    return { kind: "error", message: `The WordPress export file could not be read: ${wxr.errors[0] ?? "it is not well-formed XML"}.` };
  }
  const conversion = mapWordPressExport(exp, { source: "wordpress-wxr", rawContent: true, now });
  if (wxr.errorCount > 0) {
    conversion.report.lines.push(`The file had ${wxr.errorCount} XML problem(s) (first: ${wxr.errors[0]}). Reading carried on past them; compare the counts above with the WordPress dashboard.`);
    (conversion.document.conversion as { lines: string[] }).lines = conversion.report.lines.slice(0, 50);
  }
  return { kind: "wxr", conversion, bytes: total };
}
