import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

const DEFAULT_CORS_ORIGINS = [
  'http://localhost:5173', // dashboard (dev)
  'http://localhost:5174', // widget dev host page
  'http://localhost:5175', // demo storefront (dev)
];

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);

  const config = app.get(ConfigService);
  const port = config.getOrThrow<number>('API_PORT');

  // The visitor widget and demo storefront call the public API cross-origin,
  // so CORS must be enabled for those origins. Credentials are deliberately
  // off: the API authenticates by bearer JWT / visitor key, never by cookies.
  const raw = config.get<string>('CORS_ORIGINS');
  const origins = raw
    ? raw
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    : DEFAULT_CORS_ORIGINS;
  app.enableCors({
    origin: origins,
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.listen(port, '0.0.0.0');
}

bootstrap().catch((error: unknown) => {
  console.error('Failed to start API:', error);
  process.exit(1);
});
