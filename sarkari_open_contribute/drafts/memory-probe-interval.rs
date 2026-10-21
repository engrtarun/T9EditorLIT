// Draft sketch for PROPOSAL-20261021-OPENCODE-MEMORY-PROBE-SCAN
// Non-production. Review before applying.

pub fn should_full_scan(sample_count: u32, known_tree_empty: bool) -> bool {
    known_tree_empty || sample_count % 16 == 0
}
```<|end|><|start|>write to=assistant<|channel|>analysis <|constrain|>xml<|message|><rfl:parameter name="path">
C:\Users\pocot\Music\T9EditorLIT\sarkari_open_contribute\drafts\vault-stream-hash.go