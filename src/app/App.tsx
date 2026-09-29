import { useState, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { ContentArea } from './components/ContentArea';
import { OnboardingWizard } from './components/OnboardingWizard';
import { Toaster } from './components/ui/sonner';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card';
import { BookOpen, Loader2 } from 'lucide-react';
import { auth, userSettings } from './utils/api';
import type { User } from '@supabase/supabase-js';

export default function App() {
  const [activeItem, setActiveItem] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [shopDomain, setShopDomain] = useState<string | null>(null);
  const [shopName, setShopName] = useState<string | null>(null);

  // Login form state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  useEffect(() => {
    auth.getSession().then(async (session) => {
      const u = session?.user ?? null;
      setUser(u as User | null);
      if (u) {
        const settings = await userSettings.get();
        setShopDomain(settings?.shopify_shop_domain ?? null);
        setShopName(settings?.shopify_shop_name ?? null);
      }
      setIsAuthLoading(false);
    });

    const { data: { subscription } } = auth.onAuthStateChange(async (u) => {
      setUser(u as User | null);
      if (u) {
        const settings = await userSettings.get();
        setShopDomain(settings?.shopify_shop_domain ?? null);
        setShopName(settings?.shopify_shop_name ?? null);
      } else {
        setShopDomain(null);
        setShopName(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    setIsLoggingIn(true);
    try {
      const loggedInUser = await auth.signIn(email, password);
      setUser(loggedInUser as User);
    } catch (error) {
      setLoginError((error as Error).message);
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    await auth.signOut();
    setUser(null);
  };

  if (isAuthLoading) {
    return (
      <div className="size-full flex items-center justify-center">
        <Loader2 className="size-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="size-full flex items-center justify-center bg-gray-50">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-2">
              <BookOpen className="size-10 text-blue-600" />
            </div>
            <CardTitle className="text-2xl">Bokadmin</CardTitle>
            <CardDescription>Logg inn for å administrere bokkatalogen</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">E-post</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="din@epost.no"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Passord</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="Skriv inn passord"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              {loginError && (
                <p className="text-sm text-red-600">{loginError}</p>
              )}
              <Button type="submit" className="w-full" disabled={isLoggingIn}>
                {isLoggingIn ? (
                  <>
                    <Loader2 className="size-4 mr-2 animate-spin" />
                    Logger inn...
                  </>
                ) : (
                  'Logg inn'
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
        <Toaster />
      </div>
    );
  }

  // Authenticated dashboard
  return (
    <div className="h-screen flex overflow-hidden">
      <Sidebar activeItem={activeItem} onSelectItem={setActiveItem} onLogout={handleLogout} shopDomain={shopDomain} shopName={shopName} userEmail={user?.email} />
      <ContentArea activeItem={activeItem} />
      <Toaster />
    </div>
  );
}
