import { BACKEND_URL } from '../config/constants';

export const register = async (name, email, password) => {
  const res = await fetch(`${BACKEND_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password }),
  });
  return res.json();
};

export const login = async (email, password) => {
  const res = await fetch(`${BACKEND_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return res.json();
};

export const getMe = async (token) => {
  const res = await fetch(`${BACKEND_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
};
