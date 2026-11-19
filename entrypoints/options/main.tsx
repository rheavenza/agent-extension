import React from 'react';
import ReactDOM from 'react-dom/client';
import '@/assets/style.css';
import SettingsPage from '@/components/SettingsPage';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsPage />
  </React.StrictMode>,
);
