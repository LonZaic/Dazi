/// <reference types="vite/client" />

// 声明 .vue 文件模块，让 IDE 识别 Vue SFC 导入
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
