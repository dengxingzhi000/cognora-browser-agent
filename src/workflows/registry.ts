import { WorkflowRegistry } from './index.js';
import {
  actionsRunWorkflow,
  blockerWorkflow,
  realLoginWorkflow,
} from './builtin.js';
import { productCreateWorkflow, fixtureProductCreateWorkflow } from './product-create.js';

export function createDefaultWorkflowRegistry(): WorkflowRegistry {
  return new WorkflowRegistry([
    productCreateWorkflow,
    fixtureProductCreateWorkflow,
    realLoginWorkflow,
    blockerWorkflow,
    actionsRunWorkflow,
  ]);
}

export * from './index.js';
export * from './builtin.js';
export * from './product-create.js';
