import { I18nProvider } from '@lingui/react';
import { i18n, loadLanguage } from '@/i18n';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import '@/index.css';
import App from '@/App';

void loadLanguage().catch(() => {
  /* Keep the cached language while offline. */
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider i18n={i18n}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </I18nProvider>
  </StrictMode>,
);
