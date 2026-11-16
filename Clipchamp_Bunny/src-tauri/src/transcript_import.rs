//! Read a transcript the user exported from another tool.
//!
//! The app's own transcripts come from ElevenLabs/Groq through the daemon. A
//! user who does not want to spend the API budget can run the same speech-to-text
//! on elevenlabs.io and download the result. That download is a file - Text,
//! SRT, VTT, JSON, HTML, DOCX or PDF - and this module turns it into plain text
//! for the TypeScript parser in `src/lib/transcript-import.ts`.
//!
//! Only two formats need native code: DOCX is a ZIP with `word/document.xml`
//! inside it, and PDF needs a parser. Everything else is read as text.
//!
//! **Zero-RAM rules still apply.** Nothing here decompresses a whole document
//! into memory without a cap: there is a byte limit per file, a cap on the
//! decompressed XML, and the result is refused (not silently truncated) when
//! it would be bigger than the frontend is willing to parse.

use std::fmt;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// A deliberate ceiling: a 3-hour transcript is well under a megabyte, so
/// anything above this is a different file (or a ZIP bomb), not a transcript.
const MAX_TEXT_BYTES: u64 = 8 * 1024 * 1024;
/// DOCX/PDF carry layout on top of the words; they need more room than plain
/// text but still nowhere near a media file.
const MAX_DOC_BYTES: u64 = 24 * 1024 * 1024;
/// `word/document.xml` after decompression. A real document is far below it.
const MAX_DOCX_XML_BYTES: u64 = 32 * 1024 * 1024;
/// The frontend refuses to parse more than 4 M characters; refusing here is
/// more honest than handing over a file that is silently cut in half.
const MAX_TEXT_CHARS: usize = 4_000_000;

/// What the frontend receives. `kind` is the native format, so the UI can say
/// "PDF se text nikala" instead of pretending the user pasted text.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTranscript {
    pub name: String,
    /// `text`, `docx` or `pdf`.
    pub kind: &'static str,
    pub text: String,
    /// Bytes read from disk (the real size, even when the text is shorter).
    pub bytes: u64,
}

impl fmt::Display for ImportedTranscript {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({} bytes)", self.name, self.bytes)
    }
}

/// The formats the import dialog offers, in the order the picker shows them.
pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "srt", "vtt", "json", "html", "htm", "docx", "pdf",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text,
    Docx,
    Pdf,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Text => "text",
            Kind::Docx => "docx",
            Kind::Pdf => "pdf",
        }
    }
}

fn extension(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

fn kind_of(path: &Path) -> Result<Kind, String> {
    match extension(path).as_str() {
        "txt" | "md" | "markdown" | "srt" | "vtt" | "json" | "html" | "htm" => Ok(Kind::Text),
        "docx" => Ok(Kind::Docx),
        "pdf" => Ok(Kind::Pdf),
        other => Err(format!(
            "\"{other}\" format abhi support nahi hai. Text, PDF, DOCX, JSON, HTML, SRT ya VTT export karo."
        )),
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn check_size(path: &Path, limit: u64) -> Result<u64, String> {
    let meta = fs::metadata(path).map_err(|e| format!("File nahi mili: {e}"))?;
    if !meta.is_file() {
        return Err("Ye file nahi hai.".into());
    }
    if meta.len() > limit {
        return Err(format!(
            "File bahut badi hai ({} MB). Import ki limit {} MB hai - transcript ko Text me export karke try karo.",
            meta.len() / (1024 * 1024),
            limit / (1024 * 1024)
        ));
    }
    Ok(meta.len())
}

/// Decode a text file the way Windows actually saves them.
///
/// Notepad's "Unicode" is UTF-16LE **with a BOM**; a JSON export from a web app
/// is UTF-8; an older subtitle is often Windows-1252. Guessing wrong turns
/// Hindi into `????`, so the BOM is checked first, then UTF-8, then a lossy
/// fallback that keeps every readable byte.
pub fn decode_text_bytes(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return utf16_to_string(&bytes[2..], true);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return utf16_to_string(&bytes[2..], false);
    }
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(body) {
        Ok(text) => text.to_owned(),
        // `from_utf8_lossy` never fails, so a weird byte can cost one symbol,
        // never the whole import.
        Err(_) => String::from_utf8_lossy(body).into_owned(),
    }
}

fn utf16_to_string(bytes: &[u8], little_endian: bool) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| {
            if little_endian {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        })
        .collect();
    String::from_utf16_lossy(&units)
}

/* --------------------------------------------------------------------- DOCX */

fn decode_xml_entities(input: &str) -> String {
    if !input.contains('&') {
        return input.to_owned();
    }
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let tail = &rest[amp..];
        let Some(semi) = tail.find(';') else {
            out.push_str(tail);
            return out;
        };
        let body = &tail[1..semi];
        let decoded = match body {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ if body.starts_with("#x") || body.starts_with("#X") => {
                u32::from_str_radix(&body[2..], 16)
                    .ok()
                    .and_then(char::from_u32)
            }
            _ if body.starts_with('#') => body[1..].parse::<u32>().ok().and_then(char::from_u32),
            _ => None,
        };
        match decoded {
            Some(ch) => out.push(ch),
            None => out.push_str(&tail[..=semi]),
        }
        rest = &tail[semi + 1..];
    }
    out.push_str(rest);
    out
}

/// The visible text of `word/document.xml`.
///
/// A DOCX has no line breaks stored as text: each `<w:p>` is a paragraph, each
/// `<w:br>` a manual break, each `<w:tab>` a tab. Text lives in `<w:t>`; field
/// codes (`<w:instrText>`: page numbers, TOC instructions) are not speech and
/// are dropped.
pub fn docx_xml_to_text(xml: &str) -> String {
    let xml = xml.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::with_capacity(xml.len() / 3);
    let mut in_text = false;
    let mut rest = xml.as_str();
    while let Some(lt) = rest.find('<') {
        if in_text {
            out.push_str(&decode_xml_entities(&rest[..lt]));
        }
        let Some(gt_rel) = rest[lt..].find('>') else {
            break;
        };
        let gt = lt + gt_rel;
        let tag = rest[lt + 1..gt].trim();
        let closing = tag.starts_with('/');
        let name = tag
            .trim_start_matches('/')
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim_end_matches('/');
        match name {
            "w:t" => in_text = !closing && !tag.ends_with('/'),
            "w:instrText" | "w:delText" => in_text = false,
            "w:tab" => out.push('\t'),
            "w:br" | "w:cr" => out.push('\n'),
            "w:p" if closing => out.push('\n'),
            _ => {}
        }
        rest = &rest[gt + 1..];
    }
    normalize_doc_text(&out)
}

fn normalize_doc_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut blank_run = 0usize;
    for line in input.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
        } else {
            blank_run = 0;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(line.trim_end());
    }
    out.trim().to_owned()
}

fn read_docx(path: &Path, bytes: u64) -> Result<ImportedTranscript, String> {
    let file = fs::File::open(path).map_err(|e| format!("DOCX nahi khuli: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|_| {
        "Ye .docx file padhi nahi ja saki. Word me \"Save As .docx\" karke dobara try karo."
            .to_string()
    })?;
    // Word 2007+ keeps the body here; headers/footers are not the transcript.
    let mut entry = archive
        .by_name("word/document.xml")
        .map_err(|_| "DOCX ke andar transcript body nahi mili.".to_string())?;
    let mut xml = String::new();
    entry
        .by_ref()
        .take(MAX_DOCX_XML_BYTES + 1)
        .read_to_string(&mut xml)
        .map_err(|e| format!("DOCX padhne me dikkat: {e}"))?;
    if xml.len() as u64 > MAX_DOCX_XML_BYTES {
        return Err("DOCX bahut bada hai - chhote hisson me export karo.".into());
    }
    let text = docx_xml_to_text(&xml);
    finish(path, Kind::Docx, text, bytes)
}

/* ---------------------------------------------------------------------- PDF */

fn read_pdf(path: &Path, bytes: u64) -> Result<ImportedTranscript, String> {
    // `pdf-extract` reads the document itself; the path (not the bytes) is
    // handed over so the parser can stream pages instead of duplicating the
    // whole file in this process.
    let raw = pdf_extract::extract_text(path).map_err(|e| {
        format!("PDF ka text nahi nikla: {e}. PDF ko Text ya DOCX me export karke try karo.")
    })?;
    let text = raw
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\u{000c}', "\n\n");
    finish(path, Kind::Pdf, normalize_doc_text(&text), bytes)
}

/* --------------------------------------------------------------------- entry */

fn finish(path: &Path, kind: Kind, text: String, bytes: u64) -> Result<ImportedTranscript, String> {
    if text.trim().is_empty() {
        return Err(
            "File me koi text nahi mila. Check karo ki export me transcript shaamil tha.".into(),
        );
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(format!(
            "Transcript bahut lamba hai ({} lakh characters). Itni badi file ek saath import nahi hoti - video ko hisson me export karo.",
            text.chars().count() / 100_000
        ));
    }
    Ok(ImportedTranscript {
        name: file_name(path),
        kind: kind.as_str(),
        text,
        bytes,
    })
}

/// Read any supported transcript file into text.
pub fn read_file(path: &Path) -> Result<ImportedTranscript, String> {
    let kind = kind_of(path)?;
    let bytes = match kind {
        Kind::Text => check_size(path, MAX_TEXT_BYTES)?,
        Kind::Docx | Kind::Pdf => check_size(path, MAX_DOC_BYTES)?,
    };
    match kind {
        Kind::Text => {
            let raw = fs::read(path).map_err(|e| format!("File padhi nahi ja saki: {e}"))?;
            let text = decode_text_bytes(&raw)
                .replace("\r\n", "\n")
                .replace('\r', "\n");
            finish(path, kind, text, bytes)
        }
        Kind::Docx => read_docx(path, bytes),
        Kind::Pdf => read_pdf(path, bytes),
    }
}

/// Read a file the frontend already picked, plus its extension.
///
/// Kept separate from the Tauri command so it can be unit-tested without an
/// app handle (CI runs `cargo test` for both frontends).
pub fn read_path(path: PathBuf) -> Result<ImportedTranscript, String> {
    if path.as_os_str().is_empty() {
        return Err("Koi file select nahi hui.".into());
    }
    read_file(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "t9-import-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            name
        ));
        dir
    }

    #[test]
    fn decodes_utf16le_with_bom() {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "Namaste doston".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_text_bytes(&bytes), "Namaste doston");
    }

    #[test]
    fn decodes_utf8_with_and_without_bom() {
        let text = "Namaste — doston";
        assert_eq!(decode_text_bytes(text.as_bytes()), text);
        let mut with_bom = vec![0xEF, 0xBB, 0xBF];
        with_bom.extend_from_slice(text.as_bytes());
        assert_eq!(decode_text_bytes(&with_bom), text);
    }

    #[test]
    fn docx_xml_becomes_paragraphs_and_tabs() {
        let xml = r#"<w:document><w:body>
            <w:p><w:r><w:t>Namaste</w:t></w:r><w:r><w:tab/><w:t>doston</w:t></w:r></w:p>
            <w:p><w:r><w:t xml:space="preserve">Aaj hum </w:t></w:r>
                 <w:r><w:t>&amp; sabhi</w:t></w:r><w:r><w:br/><w:t>line do</w:t></w:r></w:p>
            <w:p><w:r><w:instrText>PAGE</w:instrText></w:r></w:p>
        </w:body></w:document>"#;
        let text = docx_xml_to_text(xml);
        assert_eq!(text, "Namaste\tdoston\nAaj hum & sabhi\nline do");
    }

    #[test]
    fn docx_zip_is_read_through_the_archive() {
        let path = temp_path("sample.docx");
        {
            use std::io::Write;
            let file = fs::File::create(&path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options: zip::write::SimpleFileOptions = Default::default();
            zip.start_file("word/document.xml", options).unwrap();
            zip.write_all(b"<w:document><w:body><w:p><w:r><w:t>Hello doston</w:t></w:r></w:p></w:body></w:document>")
                .unwrap();
            zip.finish().unwrap();
        }
        let got = read_file(&path).unwrap();
        assert_eq!(got.kind, "docx");
        assert_eq!(got.text, "Hello doston");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn text_files_round_trip_and_normalise_newlines() {
        let path = temp_path("sample.srt");
        fs::write(&path, "1\r\n00:00:01,000 --> 00:00:02,000\r\nNamaste\r\n").unwrap();
        let got = read_file(&path).unwrap();
        assert_eq!(got.kind, "text");
        assert!(got.text.contains("Namaste"));
        assert!(!got.text.contains('\r'));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn unsupported_extension_says_what_to_use() {
        let path = temp_path("sample.png");
        let err = read_file(&path).unwrap_err();
        assert!(err.contains("support nahi"), "{err}");
    }

    #[test]
    fn an_empty_file_is_refused_instead_of_returning_nothing() {
        let path = temp_path("empty.txt");
        fs::write(&path, "   \n\n").unwrap();
        let err = read_file(&path).unwrap_err();
        assert!(err.contains("koi text nahi"), "{err}");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn oversized_files_are_refused_before_reading() {
        let path = temp_path("big.txt");
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_TEXT_BYTES + 1).unwrap();
        drop(file);
        let err = read_file(&path).unwrap_err();
        assert!(err.contains("bahut badi"), "{err}");
        let _ = fs::remove_file(&path);
    }
}
