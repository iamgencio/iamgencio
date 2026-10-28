import { Suspense } from 'react';
import { AuthForm } from '@/components/AuthForm';
export const metadata = { title: 'Inscription' };
export default function Page() { return <Suspense><AuthForm mode="register" /></Suspense>; }
