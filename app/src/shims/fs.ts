// @arcium-hq/client only touches `fs` to load files from disk, which the app
// never does.
export function readFileSync(): never {
  throw new Error("The file system is not available in the browser");
}

export default { readFileSync };
