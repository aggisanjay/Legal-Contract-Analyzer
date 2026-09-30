export type DocumentStatus = 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED';

export interface DocumentMetadata {
  id: string;
  filename: string;
  originalFilename: string;
  mimeType: string;
  size: number;
  status: DocumentStatus;
  statusMessage?: string | null;
  processingStage?: string | null;
  pageCount: number;
  originalFilePath: string;
  renderedPdfPath?: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
  chunksCount?: number;
}

export interface DocumentChunkData {
  id: string;
  documentId: string;
  chunkIndex: number;
  text: string;
  pageStart: number;
  pageEnd: number;
  startOffset: number;
  endOffset: number;
  embedding?: number[] | string | null;
  sectionNumber?: string | null;
  sectionTitle?: string | null;
}

export interface ExtractedPage {
  pageNumber: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface ExtractedDocument {
  text: string;
  pageCount: number;
  pages: ExtractedPage[];
  sections: {
    sectionNumber: string;
    sectionTitle: string;
    text: string;
    startOffset: number;
    endOffset: number;
    pageStart: number;
    pageEnd: number;
  }[];
}

export interface VerifiedCitation {
  id: string;
  documentId: string;
  documentName: string;
  quote: string;
  verified: boolean;
  startOffset?: number;
  endOffset?: number;
  pageStart?: number;
  pageEnd?: number;
  reason?: string;
  matchScore?: number;
}

export type QuoteVerificationResult =
  | {
      verified: true;
      quote: string;
      documentId: string;
      startOffset: number;
      endOffset: number;
      pageStart: number;
      pageEnd: number;
      confidence?: number;
    }
  | {
      verified: false;
      quote: string;
      reason: string;
    };

export interface CoverageInfo {
  chunksExamined: number;
  chunksTotal: number;
  pagesExamined: number;
  pagesTotal: number;
  strategy: string;
  incomplete?: boolean;
}

export interface AgentTimelineStep {
  round?: number;
  tool?: string;
  args?: Record<string, unknown>;
  message: string;
  stage?: string;
}

export interface ChatMessage {
  id: string;
  conversationId?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  citations?: VerifiedCitation[];
  unverifiedCitations?: VerifiedCitation[];
  notice?: string;
  coverage?: CoverageInfo;
  timeline?: AgentTimelineStep[];
  interrupted?: boolean;
  createdAt: string | Date;
}

export type SignificanceLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface ClauseDifference {
  id: string;
  sectionNumber?: string;
  title: string;
  significance: SignificanceLevel;
  changeType?: 'added' | 'removed' | 'modified' | 'reworded';
  originalText: string;
  revisedText: string;
  substantiveChange: string;
  plainLanguageImpact: string;
  numericOrDateChanges?: string;
  diffSegments?: Array<{
    type: 'equal' | 'insert' | 'delete';
    text: string;
  }>;
}

export interface ContractComparisonResult {
  id?: string;
  documentAId: string;
  documentAName: string;
  documentBId: string;
  documentBName: string;
  differences: ClauseDifference[];
  summary: {
    highCount: number;
    mediumCount: number;
    lowCount: number;
    totalCount: number;
    generalAssessment: string;
  };
}

export interface AgentProgressEvent {
  stage: 'searching' | 'reading' | 'reasoning' | 'verifying' | 'generating' | 'done' | 'error';
  message: string;
  toolCall?: {
    tool: string;
    args: Record<string, unknown>;
  };
  round?: number;
}

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentToolResult {
  toolCallId: string;
  name: string;
  result: unknown;
  error?: string;
}
