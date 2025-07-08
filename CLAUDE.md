# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hydro is a comprehensive Online Judge system designed for programming education and contests. It features a modular plugin architecture built on Cordis framework, supporting multiple programming languages, contest formats, and deployment methods.

## Architecture

### Monorepo Structure
- **Yarn Workspaces** with modern Yarn v4.9.1 using PnP
- **Main packages**: `packages/` (core functionality)
- **Framework**: `framework/` (plugin system)
- **Plugins**: `plugins/` (optional extensions)
- **Modules**: `modules/` (additional components)

### Core Components
- **Backend**: `packages/hydrooj` - Main Node.js/Koa server with MongoDB
- **Frontend**: `packages/ui-default` - React-based UI with Webpack
- **Judge**: `packages/hydrojudge` - Independent code evaluation system
- **Framework**: `packages/framework` - Cordis-based plugin system

## Development Commands

### Build & Development
```bash
# Install dependencies
yarn install

# Build entire project
yarn build

# Development build with watch
yarn build:watch

# Frontend development
yarn build:ui:dev          # Development build with hot reload
yarn build:ui:dev:https    # HTTPS development server
yarn build:ui:production   # Production frontend build

# Start backend server
yarn start                 # Production mode
yarn debug                 # Debug mode with inspector

# CLI access
yarn hydrooj               # Access hydrooj CLI commands
```

### Testing & Quality
```bash
yarn test                  # Run test suite
yarn benchmark             # Performance benchmarks
yarn lint                  # ESLint with auto-fix
yarn lint:ci               # CI linting (no auto-fix)
yarn oxlint                # Fast Rust-based linting
```

### Database & Deployment
```bash
# Database operations (via hydrooj CLI)
hydrooj backup             # Backup system data
hydrooj restore <file>     # Restore from backup

# Docker deployment
cd install/docker
docker-compose up -d       # Start all services
```

## Key Technologies

### Backend Stack
- **Framework**: Cordis (plugin system), Koa (HTTP server)
- **Database**: MongoDB v6 with official driver
- **Language**: TypeScript throughout
- **Authentication**: JWT, WebAuthn, OAuth integrations
- **File Storage**: AWS S3, local filesystem support

### Frontend Stack
- **Framework**: React 18 with hooks
- **Build**: Webpack 5 with advanced optimizations
- **Styling**: Stylus, component-based CSS
- **Editor**: Monaco Editor (VS Code editor component)
- **State**: Redux for global state management

### Judge System
- **Sandbox**: Custom implementation with Docker support
- **Languages**: Extensive support (C/C++, Python, Java, etc.)
- **Communication**: WebSocket-based real-time updates
- **Evaluation**: Multiple judge types (Traditional, Special Judge, Interactive)

## Plugin Development

### Plugin Structure
- Plugins use Cordis framework for lifecycle management
- Use dependency injection via `ctx.inject()` and `ctx.provide()`
- Hot-pluggable without system restart
- Follow the existing plugin patterns in `plugins/` directory

### Common Plugin APIs
```typescript
// Basic plugin structure
export default function plugin(ctx: Context) {
  ctx.on('ready', () => {
    // Plugin initialization
  });
  
  ctx.inject('database', (db) => {
    // Use injected services
  });
}
```

## Database Schema

### MongoDB Collections
- **users**: User accounts and profiles
- **problems**: Problem statements and metadata
- **records**: Submission records and results
- **contests**: Contest configurations
- **domains**: Multi-tenant domain data

### Data Access Patterns
- Use the built-in database abstraction layer
- Leverage existing models in `packages/hydrooj/src/model/`
- Follow the domain-based data isolation pattern

## Testing

### Test Structure
- Unit tests in `packages/*/tests/`
- Integration tests in `packages/hydrooj/src/test/`
- Use MongoDB Memory Server for database testing
- Custom test runner with Chai assertions

### Running Specific Tests
```bash
# Single test file
node -r @hydrooj/register packages/common/tests/subtask.spec.ts

# Full test suite
yarn test
```

## Installation Methods

### Production Deployment
```bash
# Automated script (recommended)
LANG=zh . <(curl https://hydro.ac/setup.sh)

# Docker deployment
git clone https://github.com/hydro-dev/Hydro.git
cd Hydro/install/docker
docker-compose up -d
```

### Development Setup
```bash
git clone https://github.com/hydro-dev/Hydro.git
cd Hydro
yarn install
yarn build
```

## Configuration

### Environment Variables
- `HYDRO_HOST`: Server bind address (default: 127.0.0.1)
- `HYDRO_PORT`: Server port (default: 8888)
- Database connection via MongoDB URI
- S3 credentials for file storage (optional)

### Plugin Management
```bash
hydrooj install <plugin-name>    # Install plugin
hydrooj uninstall <plugin-name>  # Remove plugin
```

## Code Style & Standards

### TypeScript Configuration
- Strict TypeScript configuration
- ESLint with custom rules in `framework/eslint-config/`
- Prettier for code formatting
- Use existing type definitions in `packages/common/src/`

### Development Guidelines
- Follow existing patterns in codebase
- Use dependency injection for service access
- Implement proper error handling
- Write tests for new functionality
- Use semantic versioning for releases

## Multi-language Support

### Adding Translations
- Translation files in `packages/*/locale/` directories
- YAML format with sorted keys
- Support for array-style and object-style substitutions
- Fallback logic: specific locale → language → English → key

### Translation Usage
```typescript
// Backend
i18n('translation.key').format(args);

// Frontend  
substitute(i18n('translation.key'), args);
```

## Performance Considerations

### Database Optimization
- Proper indexing for MongoDB collections
- Use pagination for large datasets
- Implement caching where appropriate
- Monitor database performance with built-in tools

### Frontend Optimization
- Code splitting with Webpack
- Lazy loading for optimal performance
- Service worker for offline capabilities
- Asset optimization and compression

## Security

### Built-in Security Features
- Sandbox isolation for code execution
- XSS/CSRF protection in frontend
- Input validation throughout
- Permission-based access control
- WebAuthn support for secure authentication

### Security Best Practices
- Never commit secrets or API keys
- Use proper input sanitization
- Follow principle of least privilege
- Regular security updates for dependencies