# Frozen persistence migration fixture

`save-v1-in-progress.json` is a real save produced by the validated pre-navigation core, rather than a v2 world relabeled as an older schema.

- Source: isolated `validation-save-milestone` snapshot of remote commit `c5e7b206`
- Initial validated archive tree: `d8071e62c8a13d096757faf725c9e8af6c8184fb`
- Source save version: `1`
- Source simulation version: `0.1.1`
- Save checksum: `b4d448f7`
- File SHA-256: `f6e63f5945a3416d031cd19958995f8bb08bde24bfe4bd848b4f630ed4a3e551`
- Scenario: seed `legacy-navigation-fixture`, accepted `legacy.plank` production, 47 elapsed work ticks, three wood reserved, unfinished transaction
- Copied without modification from the navigation worker's `tests/agents/fixtures/save-v1-in-progress.json`

The migration storage tests insert this original record directly into IndexedDB. Loading and exporting must preserve its original text, checksum, pointer and revision. A subsequent explicit save may create a current-schema generation under the existing retention policy. Migration itself must not write back or silently clear unsupported records.
