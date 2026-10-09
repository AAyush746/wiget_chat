import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';

const loginMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/api')>();
  return { ...original, login: loginMock };
});

function renderPage(onSuccess = vi.fn()) {
  return render(<LoginPage onSuccess={onSuccess} />);
}

describe('LoginPage', () => {
  it('renders the sign-in form', () => {
    const { getByRole, getByLabelText } = renderPage();
    expect(getByRole('heading', { name: 'ChatFlow dashboard' })).toBeInTheDocument();
    expect(getByLabelText('Email')).toBeInTheDocument();
    expect(getByLabelText('Password')).toBeInTheDocument();
    expect(getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  it('submits credentials and passes the token to onSuccess', async () => {
    loginMock.mockResolvedValueOnce({ accessToken: 'token-abc', user: {} });
    const onSuccess = vi.fn();
    const user = userEvent.setup();
    renderPage(onSuccess);

    await user.type(screen.getByLabelText('Email'), 'agent@example.com');
    await user.type(screen.getByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('token-abc'));
    expect(loginMock).toHaveBeenCalledWith('agent@example.com', 'secret');
  });

  it('shows a friendly error for invalid credentials', async () => {
    const { ApiError } = await import('../lib/api');
    (loginMock as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError(401, 'Unauthorized'),
    );
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Email'), 'agent@example.com');
    await user.type(screen.getByLabelText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.');
  });

  it('disables the submit button while the request is pending', async () => {
    let release!: (v: unknown) => void;
    loginMock.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const user = userEvent.setup();
    const { getByRole } = renderPage();

    await user.type(screen.getByLabelText('Email'), 'agent@example.com');
    await user.type(screen.getByLabelText('Password'), 'secret');
    const button = getByRole('button', { name: 'Sign in' });
    await user.click(button);

    await waitFor(() => expect(loginMock).toHaveBeenCalled());
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Signing in…');

    release({ accessToken: 't', user: {} });
  });
});
