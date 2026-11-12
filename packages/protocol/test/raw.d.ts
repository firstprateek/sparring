// A fixture read as text: vitest serves `?raw` imports as the file's contents.
declare module "*.md?raw" {
  const text: string;
  export default text;
}
