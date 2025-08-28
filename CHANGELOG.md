# Changelog

All notable changes to Bubble Tab Manager will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2024-08-28

### Fixed
- Fixed critical bug where tabs would move to duplicate groups after page refresh or Bubble navigation
- Improved Chrome API error handling during tab transitions to prevent group mapping corruption
- Tabs now consistently stay in their original groups during refresh and navigation

### Improved  
- Enhanced code quality by fixing linting issues and removing unused code
- More robust error handling for temporary Chrome API instabilities
- Better logging for debugging group management issues

## [1.0.0] - Initial Release

### Added
- Automatic tab grouping by app and version
- Smart tab titles with branch name scraping
- Dynamic favicons based on editor section
- Custom domain support with security validation
- Persistent settings and preferences
- Intelligent color management for tab groups