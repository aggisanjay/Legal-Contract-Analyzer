import { storage, StorageProvider } from '../storage';

export type { StorageProvider as DocumentStorage } from '../storage';
export { storage as documentStorage, DatabaseStorageProvider, LocalStorageProvider, getStorageProvider } from '../storage';
