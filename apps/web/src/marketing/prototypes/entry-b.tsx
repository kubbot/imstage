import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import LaunchB from './launch-b';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LaunchB />
  </StrictMode>,
);
