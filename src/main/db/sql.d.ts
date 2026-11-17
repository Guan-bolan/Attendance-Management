/** Vite 的 `?raw` 导入（主进程打包与 vitest 都走同一条转换链，不依赖运行期读文件） */
declare module '*.sql?raw' {
  const content: string
  export default content
}
