# Scene file format

Scenes are saved with nstructjs, either as binary (`.sa3d`) or as JSON (`.sa3d.json`). The code
is in `src/core/fileio.ts`; tests are in `tests/fileio.test.ts` and `tests/migration.test.ts`.

## Layout

- **Binary:** an nstructjs `FileHelper` file.
  - Header: the magic `SA3D` and a version `major.minor.micro`.
  - The `write_scripts()` dump: every registered struct's schema, with its id.
  - One block per top-level object; the only one so far is `SCEN` (the `sa3d.Scene`).
- **JSON:** one object:
  - `magic`: `"SA3D"`
  - `version`: `[major, minor, micro]`
  - `structScripts`: the `write_scripts()` dump, the same as binary
  - `scene`: `nstructjs.writeJSON(scene)`
- **Detecting the format:** `readSceneAuto` checks the first four bytes for the magic.
- **Size:** a 1024² paint map is about 24.5 MB as JSON, so JSON is for debugging and diffing.

## How old files load

- **Binary reads against the file's embedded scripts,** not the current classes:
  - A field the current class no longer has is still assigned to the instance, so
    `migrateSTRUCT` can read it.
  - A field the current class added keeps its constructor default.
- **JSON reads against the current schema:**
  - Keys that don't match a current field are skipped, unless `migrateSTRUCT` moves them first.
  - `migrateSTRUCT` runs on the raw JSON object before the read.
- **The version passed to `readJSON` must be an integer:** use
  `nstructjs.filehelper.versionToInt(version)`. An array is accepted silently, and every
  `version < V` guard is then false.

## Changing a struct

1. Bump `FILE_VERSION` in `src/core/const.ts`.
2. Add one guard per historical step to the class's static `migrateSTRUCT`:

   ```ts
   static migrateSTRUCT(version: number, data: Record<string, unknown>, finish?: () => void) {
     if (version < nstructjs.filehelper.versionToInt([0, 2, 0])) {
       data.newName = data.oldName;
       delete data.oldName;
     }
     finish?.(); // always: on JSON it continues the walk into nested structs
   }
   ```

3. Write the guard so it works both on a half-loaded instance (binary) and on raw JSON.
   - The two paths run migrations in different orders. Binary runs children first, after
     `loadSTRUCT`; JSON runs parents first, before loading.
   - Never rebuild derived data in `loadSTRUCT`. `Scene.afterLoad()` does that once the
     whole file is in.
4. If a struct is renamed, record it with
   `nstructjs.manager.addStructNameMigration(version, oldName, newName)`.
5. Add a test with a hand-built old file, as `tests/migration.test.ts` does.

## Other gotchas

- **Special float values:** JSON stores NaN and ±Infinity as `null`, which loads as 0, and
  loses the sign of −0. Clamp anything that could be non-finite before saving.
- **Pooled buffers:** `FileHelper.read` ignores `DataView.byteOffset`, so bytes from Node's
  `readFileSync` (a view into a pooled buffer) must be copied first. `readSceneBinary`
  already does this.
