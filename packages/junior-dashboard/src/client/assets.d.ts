// The client build emits imported images as content-hashed files and
// replaces the import with the file URL.
declare module "*.webp" {
  const url: string;
  export default url;
}
