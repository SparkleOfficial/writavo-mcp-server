/**
 * A port of WordPress's wpautop(): the step that turns a classic-editor post's blank lines into
 * paragraphs. A WXR file stores post_content RAW, before that step, so without it every classic
 * post would arrive as one paragraph with its line breaks lost. WordPress skips it for block-editor
 * content (has_blocks), and so does the caller.
 *
 * Ported from wp-includes/formatting.php (WordPress 6.x), keeping its order of operations. The two
 * simplifications are noted inline; neither changes a word of text.
 */

const ALLBLOCKS =
  "(?:table|thead|tfoot|caption|col|colgroup|tbody|tr|td|th|div|dl|dd|dt|ul|ol|li|pre|form|map|area|blockquote|address|style|p|h[1-6]|hr|fieldset|legend|section|article|aside|hgroup|header|footer|nav|figure|figcaption|details|menu|summary)";

export function wpautop(input: string, br = true): string {
  if (input.trim() === "") return "";
  let text = `${input}\n`;

  // <pre> blocks are left exactly as written.
  const pres: string[] = [];
  if (text.includes("<pre")) {
    text = text.replace(/<pre[\s>][\s\S]*?<\/pre>/gi, (m) => {
      pres.push(m);
      return `<pre wp-pre-tag-${pres.length - 1}></pre>`;
    });
  }

  text = text.replace(/<br\s*\/?>\s*<br\s*\/?>/gi, "\n\n");
  text = text.replace(new RegExp(`(<${ALLBLOCKS}[\\s/>])`, "gi"), "\n\n$1");
  text = text.replace(new RegExp(`(</${ALLBLOCKS}>)`, "gi"), "$1\n\n");
  text = text.replace(/<hr\s*?\/?>/gi, "<hr />\n\n");
  text = text.replace(/\r\n|\r/g, "\n");
  // Simplification 1: WordPress swaps newlines INSIDE tags for a placeholder and restores them; a
  // space is equivalent inside a tag, so they become spaces.
  text = text.replace(/<[^<>]*>/g, (tag) => tag.replace(/\n/g, " "));

  if (text.includes("<option")) {
    text = text.replace(/\s*<option/g, "<option").replace(/<\/option>\s*/g, "</option>");
  }
  if (text.includes("</object>")) {
    text = text.replace(/(<object[^>]*>)\s*/g, "$1").replace(/\s*<\/object>/g, "</object>");
    text = text.replace(/\s*(<\/?(?:param|embed)[^>]*>)\s*/g, "$1");
  }
  if (text.includes("<source") || text.includes("<track")) {
    text = text.replace(/([<[](?:audio|video)[^>\]]*[>\]])\s*/g, "$1");
    text = text.replace(/\s*([<[]\/(?:audio|video)[>\]])/g, "$1");
    text = text.replace(/\s*(<(?:source|track)[^>]*>)\s*/g, "$1");
  }
  if (text.includes("<figcaption")) {
    text = text.replace(/\s*(<figcaption[^>]*>)/g, "$1");
    text = text.replace(/<\/figcaption>\s*/g, "</figcaption>");
  }

  text = text.replace(/\n\n+/g, "\n\n");
  const pees = text.split(/\n\s*\n/).filter((p) => p.trim() !== "");
  text = pees.map((p) => `<p>${p.replace(/^\n+|\n+$/g, "")}</p>\n`).join("");

  text = text.replace(/<p>\s*<\/p>/g, "");
  text = text.replace(/<p>([^<]+)<\/(div|address|form)>/gi, "<p>$1</p></$2>");
  text = text.replace(new RegExp(`<p>\\s*(</?${ALLBLOCKS}[^>]*>)\\s*</p>`, "gi"), "$1");
  text = text.replace(/<p>(<li.+?)<\/p>/gi, "$1");
  text = text.replace(/<p><blockquote([^>]*)>/gi, "<blockquote$1><p>");
  text = text.replace(/<\/blockquote><\/p>/gi, "</p></blockquote>");
  text = text.replace(new RegExp(`<p>\\s*(</?${ALLBLOCKS}[^>]*>)`, "gi"), "$1");
  text = text.replace(new RegExp(`(</?${ALLBLOCKS}[^>]*>)\\s*</p>`, "gi"), "$1");

  if (br) {
    // Simplification 2: WordPress protects <script>, <style> and <svg> from <br />; this does too,
    // by leaving any newline inside them alone.
    const guarded: string[] = [];
    text = text.replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, (m) => {
      guarded.push(m);
      return `<wp-guard-${guarded.length - 1}></wp-guard-${guarded.length - 1}>`;
    });
    text = text.replace(/<br>|<br\/>/gi, "<br />");
    text = text.replace(/(?<!<br \/>)\s*\n/g, "<br />\n");
    text = text.replace(/<wp-guard-(\d+)><\/wp-guard-\d+>/g, (_m, i: string) => guarded[Number(i)] ?? "");
  }

  text = text.replace(new RegExp(`(</?${ALLBLOCKS}[^>]*>)\\s*<br />`, "gi"), "$1");
  text = text.replace(/<br \/>(\s*<\/?(?:p|li|div|dl|dd|dt|th|pre|td|ul|ol)[^>]*>)/gi, "$1");
  text = text.replace(/\n<\/p>$/g, "</p>");

  if (pres.length) text = text.replace(/<pre wp-pre-tag-(\d+)><\/pre>/g, (_m, i: string) => pres[Number(i)] ?? "");
  return text;
}
