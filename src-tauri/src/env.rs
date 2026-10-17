//! Environment file management — read/write .env for API keys and settings.
//!
//! This module provides async file operations to read and update the .env file
//! that stores API keys and configuration. It follows Zero-RAM design by streaming
//! the file content rather than buffering large files.

#![allow(dead_code)]

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone)]
pub struct EnvEntry {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone)]
pub struct EnvInfo {
    pub path: PathBuf,
    pub entries: Vec<EnvEntry>,
    pub exists: bool,
}

#[tauri::command]
pub async fn env_path(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(dir.join(".env").to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn read_env_file(path: String) -> Result<EnvInfo, String> {
    let path = PathBuf::from(&path);

    if !path.exists() {
        return Ok(EnvInfo {
            path,
            entries: vec![],
            exists: false,
        });
    }

    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);

    let mut entries = Vec::new();
    let mut line_num = 0;

    for line_result in reader.lines() {
        line_num += 1;
        let line = line_result.map_err(|e| format!("read error at line {}: {}", line_num, e))?;

        let raw = line.trim();
        if raw.is_empty() || raw.starts_with('#') {
            entries.push(EnvEntry {
                key: raw.to_string(),
                value: String::new(),
            });
            continue;
        }

        let raw = raw.strip_prefix("export ").unwrap_or(raw);

        if let Some((key, val)) = raw.split_once('=') {
            let key = key.trim();
            let mut val = val.trim();
            if val.starts_with('"') && val.ends_with('"') && val.len() >= 2 {
                val = &val[1..val.len() - 1];
            } else if val.starts_with('\'') && val.ends_with('\'') && val.len() >= 2 {
                val = &val[1..val.len() - 1];
            }
            entries.push(EnvEntry {
                key: key.to_string(),
                value: val.to_string(),
            });
        } else {
            entries.push(EnvEntry {
                key: raw.to_string(),
                value: String::new(),
            });
        }
    }

    Ok(EnvInfo {
        path,
        entries,
        exists: true,
    })
}

#[tauri::command]
pub async fn write_env_file(path: String, entries: Vec<EnvEntry>) -> Result<(), String> {
    let path = PathBuf::from(&path);

    let content = entries
        .iter()
        .map(|e| {
            if e.value.is_empty() && !e.key.starts_with('#') {
                format!("{}={}", e.key, e.value)
            } else if e.key.starts_with('#') {
                e.key.clone()
            } else {
                format!("{}={}", e.key, e.value)
            }
        })
        .collect::<Vec<_>>()
        .join("\n");

    let parent = path.parent().ok_or("invalid path")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes())
        .map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())?;

    Ok(())
}

fn mask_value(value: &str, show: bool) -> String {
    if show || value.is_empty() {
        return value.to_string();
    }
    if value.len() <= 4 {
        return "****".to_string();
    }
    format!("{}***{}", &value[..2], &value[value.len() - 2..])
}