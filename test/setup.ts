import { afterAll } from 'vitest';
import { closeOpenedFiles } from './helpers';

afterAll(closeOpenedFiles);
