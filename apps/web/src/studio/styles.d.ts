/**
 * Ambient declaration so TypeScript accepts the studio stylesheet side-effect
 * import. Vite handles the actual CSS emission.
 */
declare module '*.css' {
  const stylesheet: string;
  export default stylesheet;
}
