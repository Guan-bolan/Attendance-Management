import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import 'antd/dist/reset.css'
import { App } from './App'

const container = document.getElementById('root')
if (!container) throw new Error('E_NO_ROOT: #root 不存在')

createRoot(container).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{ token: { borderRadius: 4, colorPrimary: '#1677ff' } }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>
)
