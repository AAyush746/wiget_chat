import { useState } from 'react';
import { LoginPage } from './app/LoginPage';
import { DashboardShell } from './app/DashboardShell';
import { chatSocket } from './lib/socket';
import { tokenStorage } from './lib/storage';
import { queryClient } from './lib/queryClient';

export function App() {
  const [token, setToken] = useState<string | null>(() => tokenStorage.get());

  const handleLoggedIn = (accessToken: string) => {
    tokenStorage.set(accessToken);
    setToken(accessToken);
  };

  const handleLoggedOut = () => {
    tokenStorage.remove();
    queryClient.clear(); // tenant data must not survive the session
    chatSocket.disconnect();
    setToken(null);
  };

  if (!token) {
    return <LoginPage onSuccess={handleLoggedIn} />;
  }

  return <DashboardShell onLogout={handleLoggedOut} />;
}
