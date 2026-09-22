import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import LaunchA from './launch-a';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LaunchA />
  </StrictMode>,
);
