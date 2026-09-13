import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { auth, db, analytics } from './lib/firebase';
import { UserProvider } from '@shared/hooks'
import App from './App';
import DevGate from './components/DevGate';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement)
  .render(
    <React.StrictMode>
      <DevGate>
        <UserProvider auth={auth} db={db}>
          <App />
        </UserProvider>
      </DevGate>
    </React.StrictMode>
  );