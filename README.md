# A record of Rust versions on CRAN machines

Collects the rustc versions reported by some packages' logs on CRAN.
Run the task with the following command (requires Deno):

```sh
$ deno task start
```

The recorded data can be formatted with DuckDB CLI as follows:

```sh
$ duckdb -c 'from read_json("https://raw.githubusercontent.com/eitsupi/cran-rust-version/refs/heads/main/output/versions.json")'
┌───────────────────────────────────┬─────────┐
│              flavor               │  rustc  │
│              varchar              │ varchar │
├───────────────────────────────────┼─────────┤
│ r-release-macos-arm64             │ 1.70.0  │
│ r-release-macos-x86_64            │ 1.70.0  │
│ r-oldrel-macos-arm64              │ 1.70.0  │
│ r-oldrel-macos-x86_64             │ 1.70.0  │
│ r-devel-windows-x86_64            │ 1.81.0  │
│ r-release-windows-x86_64          │ 1.81.0  │
│ r-oldrel-windows-x86_64           │ 1.81.0  │
│ r-devel-linux-x86_64-debian-clang │ 1.84.0  │
│ r-devel-linux-x86_64-debian-gcc   │ 1.84.0  │
│ r-devel-linux-x86_64-fedora-clang │ 1.84.0  │
│ r-devel-linux-x86_64-fedora-gcc   │ 1.84.0  │
│ r-patched-linux-x86_64            │ 1.84.0  │
│ r-release-linux-x86_64            │ 1.84.0  │
├───────────────────────────────────┴─────────┤
│ 13 rows                           2 columns │
└─────────────────────────────────────────────┘
```
