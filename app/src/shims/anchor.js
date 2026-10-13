// @arcium-hq/client imports Anchor's default export, which Anchor's browser
// build does not provide. This re-exports the real module with a default.
import * as anchor from "@anchor-lang/core";

export * from "@anchor-lang/core";
export default anchor;
