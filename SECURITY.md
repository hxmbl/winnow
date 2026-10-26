# Security

## Dependency advisories

CI's **Dependency advisories** job (`advisories` in `.github/workflows/ci.yml`) checks
the two committed lockfiles against the public advisory databases on every push and
pull request:

- `npm audit` in `web/` (GitHub Advisory Database), once for the full tree and once
  with `--omit=dev` for what ships in the app bundle;
- `cargo audit` (RustSec, `cargo-audit` pinned to 0.22.2) on `native/src-tauri/Cargo.lock`.

`web/scripts/audit-advisories.mjs` runs both and applies the policy:

| Finding | CI |
| --- | --- |
| npm, production tree, high or critical | **fails** |
| npm, dev-only (build, lint, test), any severity | reported |
| npm, moderate or low | reported |
| Cargo vulnerability, CVSS high or critical, **or no CVSS score** | **fails** |
| Cargo vulnerability, CVSS moderate or low | reported |
| Cargo informational: unmaintained, unsound, yanked | reported |
| Anything in `.github/advisory-allowlist.json` | accepted, printed with its reason |

Most RustSec advisories carry no CVSS score, so an unscored Cargo vulnerability is
treated as high rather than let through. The whole `Cargo.lock` is treated as
shipped (it is nearly all runtime code); a dev- or build-only Cargo finding that
cannot apply goes in the allowlist with that reason. A scanner that cannot run (no
network, unparsable output, a malformed allowlist) fails the job too: an incomplete
scan is never a pass.

The job never installs into the tree, updates or rewrites a lockfile, and its last step
fails if anything in the checkout changed. A clean run means no *known, unaccepted*
high/critical advisory in the locked graphs, not that the dependencies are free of risk.

**Allowlist.** Each entry in `.github/advisory-allowlist.json` names one advisory in one
package (`id`, `ecosystem`, `package`) with a `reason`, the Linear issue that holds the
decision (`tracking`) and what would reopen it (`revisit`). An entry the scanners no
longer report is printed as `STALE`; remove it.

**When the job fails:** take the smallest compatible fix the report names (a patch-level
lockfile bump, or the parent dependency that brings it in), not `npm audit fix --force`
or a blanket `cargo update`. If the advisory cannot apply to Winnow (wrong platform, the
affected API is unreachable), add an allowlist entry that says why.

**Locally**, with Node and `cargo install cargo-audit --version 0.22.2 --locked`:

```sh
node web/scripts/audit-advisories.mjs      # the CI gate, from the repo root
(cd web && npm audit && npm audit --omit=dev)
(cd native/src-tauri && cargo audit)
```

The Android Gradle build, the Docker base images and GitHub Actions themselves are
not covered by this job.

## Known residual risk: glib 0.18.5, RUSTSEC-2024-0429 (Linux)

Checked at `f3dd3998ba76fc85e31ba27d3dbcf0aa56c82b2d` (1.6.4) on 2026-10-26, RustSec
database commit `3279c99911354c400e1d41e47c7d60e39258b147`. Tracked in STRM-410.

**Advisory.** [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429)
(GHSA-wrw7-89jp-8q8g, fix in
[gtk-rs-core#1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343)): `VariantStrIter`'s
`Iterator`/`DoubleEndedIterator` methods (`next`, `nth`, `last`, `next_back`,
`nth_back`) pass an out-pointer as `&p` instead of `&mut p` to the variadic
`g_variant_get_child`; optimised builds can drop the write and then dereference a null
pointer. It is a crash (undefined behaviour), not a reported memory-disclosure or
code-execution bug. Affected `>=0.15.0, <0.20.0`; patched `>=0.20.0`. RustSec lists it as
informational (`unsound`), so `cargo audit` exits 0 with it present.

**Who brings it in.** Only the Linux desktop build. `glib 0.18.5` is the gtk-rs 0.18 (GTK3)
stack under Tauri: `tauri`/`tauri-runtime-wry` → `wry 0.57.0`, `tao 0.37.1`,
`muda 0.20.0`, `tray-icon 0.25.1` → `gtk 0.18.2`, `webkit2gtk 2.0.2`, `soup3 0.5.0`,
`javascriptcore-rs 1.1.2`, `libappindicator 0.9.0` → `glib 0.18.5`. Winnow does not depend
on glib directly. `cargo tree --locked --target <t> -e normal,build` finds no glib for
`aarch64-apple-darwin`, `x86_64-pc-windows-msvc` or `aarch64-linux-android`: the macOS,
Windows and Android builds do not contain it.

**Reachability: disproven for the current locked tree.** `VariantStrIter::new` is
`pub(crate)`; the only way to get one is `glib::Variant::array_iter_str()`. In the sources
of all 28 crates in the locked tree that depend on glib (atk, cairo-rs, gdk, gdk-pixbuf, gdkx11,
gio, gtk, javascriptcore-rs, libappindicator, muda, pango, soup3, tao, tauri,
tauri-runtime, tauri-runtime-wry, the nine Tauri plugins, tray-icon, webkit2gtk, wry)
plus glib, glib-macros and Winnow's own `native/src-tauri/src`, the only references to
`array_iter_str` or `VariantStrIter` are glib's own definition, its re-export and its unit
tests. The affected code is Rust-side only, so GLib, GTK or WebKitGTK (C) cannot call it
either, and no external input (D-Bus, web content, mail) reaches it. With
`lto = true` in the release profile the unused functions are very likely not even in the
shipped binary, but the conclusion does not rest on that.

To re-check after a dependency change (Linux tree, from `native/src-tauri`):

```sh
cargo tree --locked --target x86_64-unknown-linux-gnu -i glib -e normal,build --prefix none
# unpack each listed crate from ~/.cargo/registry/cache, then:
grep -rn 'array_iter_str\|VariantStrIter' <unpacked crates> src/
```

**Why it is not fixed here.** No glib 0.18.x release carries the fix (0.18.5 is the last
0.18 release; 0.19.x is still affected). The GTK3 crates require `glib ^0.18`, and the
newest wry (0.57.1) still requires `gtk ^0.18` and `webkit2gtk =2.0.2`, so neither a
lockfile update nor a Tauri/wry upgrade lifts it today; adding glib 0.20 directly would add a
second copy, not replace this one. A `[patch]` with a local fork would be possible but is not
justified for code nothing calls.

**Revisit when** Tauri/wry move the Linux backend off gtk-rs 0.18 / webkit2gtk 2.0.x, a glib
0.18.x fix is published, or any crate in the tree starts calling `array_iter_str` (re-run the
check above on every Tauri/wry bump). The accepted entry is in `.github/advisory-allowlist.json`.

The other informational warnings in the same graph (`proc-macro-error` 1.0.4, `zvariant`
5.15.0, `zbus_names` 4.3.4, `zvariant_derive` 5.15.0; all *unmaintained*, none a
vulnerability) are Linux-only and are recorded in the allowlist with their reasons (STRM-409).
