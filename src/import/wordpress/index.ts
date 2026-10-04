/**
 * Native WordPress import (CMS-PARITY.md, track M3): a WordPress export file (WXR) or site becomes
 * a Writavo Import Format document, which the ordinary importer then checks and applies.
 */
import { mapWordPressExport, type WordPressConversion } from "./map.js";
import { looksLikeWxr, readWxr } from "./wxr.js";

export { looksLikeWxr, readWxr, WxrReader, collect, type WxrRecord } from "./wxr.js";
export { mapWordPressExport, convertComments, commentExternalId, type ConversionReport, type WordPressConversion } from "./map.js";
export { wordpressHtmlToMarkdown, htmlToPlainText, commentHtmlToText } from "./html.js";
export { wpautop } from "./autop.js";
export { readImportBody, MAX_WXR_BYTES, type ReadImportBody } from "./stream.js";
export { probeSite, pullStep, restBase, setSiteName, PullError, type WordPressSite, type PullState, type Fetcher } from "./rest.js";
export { stagedOptions } from "./staged.js";
export { stageWxr, convertStaged, assembleStaged, clearStaged, readStageState, sniffBody, type StageStore, type StageState, type StageOutcome } from "./staged.js";
export type { WpComment, WpExport, WpItem } from "./model.js";

export type WxrConversion = WordPressConversion | { error: string };

/** A whole WXR file (text) -> the import document and its report, or why it could not be read. */
export function convertWxr(text: string, now = Date.now()): WxrConversion {
  if (!looksLikeWxr(text)) {
    return { error: "This is not a WordPress export file (WXR). In WordPress, use Tools > Export > All content, and upload the .xml file it downloads." };
  }
  const exp = readWxr(text);
  if (exp.items.length === 0 && exp.errorCount > 0) {
    return { error: `The WordPress export file could not be read: ${exp.errors[0] ?? "it is not well-formed XML"}.` };
  }
  const conversion = mapWordPressExport(exp, { source: "wordpress-wxr", rawContent: true, now });
  if (exp.errorCount > 0) {
    conversion.report.lines.push(
      `The file had ${exp.errorCount} XML problem(s) (first: ${exp.errors[0]}). Reading carried on past them; compare the counts above with the WordPress dashboard.`,
    );
    (conversion.document.conversion as { lines: string[] }).lines = conversion.report.lines.slice(0, 50);
  }
  return conversion;
}
