# build/ — electron-builder resources

This directory holds build-time assets for packaging (icons, entitlements,
installer background art, etc.). It is **not** the `dist/` output directory —
`electron-builder.yml` points `directories.buildResources` here.

## Icons

The final KageOps icon is the yin-yang disc located at
`docs/design_pack/foundation/logos/yin-yang-disc.png`. Until the design pack
lands in production, this directory ships a placeholder PNG so electron-builder
does not fail packaging.

To (re)generate the placeholder:

```bash
npx tsx scripts/generate-placeholder-icon.ts
```

When the final disc asset is ready, replace `build/icon.png` with a 1024x1024
master. electron-builder will derive `icon.ico` (Windows) and `icon.icns`
(macOS) automatically from that master; those generated files are gitignored.

## Code-signing (post-MVP)

- Windows: drop `certificate.pfx` here and wire `win.certificateFile` in
  `electron-builder.yml`.
- macOS: set `mac.identity` and drop `entitlements.mac.plist` here.

Do not commit real certificates or signing secrets.
