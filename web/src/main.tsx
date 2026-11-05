import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Landing from './site/Landing';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Landing />
  </StrictMode>,
);
