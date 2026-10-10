import { readDemoEnv } from './env';
import { Header } from './components/Header';
import { Hero } from './components/Hero';
import { ProductGrid } from './components/ProductGrid';
import { SupportSection } from './components/SupportSection';
import { SetupNotice } from './components/SetupNotice';
import { Footer } from './components/Footer';

export function App() {
  const env = readDemoEnv(import.meta.env);

  return (
    <div className="page">
      {!env.hasWebsiteKey && <SetupNotice />}
      <Header websiteKey={env.websiteKey} />
      <main>
        <Hero hasWidget={env.hasWebsiteKey} />
        <ProductGrid />
        <SupportSection hasWidget={env.hasWebsiteKey} apiUrl={env.apiUrl} />
      </main>
      <Footer />
    </div>
  );
}
