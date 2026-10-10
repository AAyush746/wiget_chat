import { Injectable, NotFoundException } from '@nestjs/common';
import type { FaqEntry } from '@chatflow/types';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateFaqDto } from './dto/create-faq.dto';
import type { UpdateFaqDto } from './dto/update-faq.dto';

@Injectable()
export class FaqsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(websiteId: string): Promise<FaqEntry[]> {
    const faqs = await this.prisma.faqEntry.findMany({
      where: { websiteId },
      orderBy: { createdAt: 'desc' },
    });
    return faqs.map((f) => this.toDto(f));
  }

  async create(websiteId: string, dto: CreateFaqDto): Promise<FaqEntry> {
    const faq = await this.prisma.faqEntry.create({
      data: {
        websiteId,
        question: dto.question.trim(),
        answer: dto.answer.trim(),
      },
    });
    return this.toDto(faq);
  }

  async update(websiteId: string, faqId: string, dto: UpdateFaqDto): Promise<FaqEntry> {
    const faq = await this.prisma.faqEntry.findFirst({
      where: { id: faqId, websiteId },
    });
    if (!faq) {
      throw new NotFoundException('FAQ not found');
    }

    const updated = await this.prisma.faqEntry.update({
      where: { id: faqId },
      data: {
        ...(dto.question !== undefined ? { question: dto.question.trim() } : {}),
        ...(dto.answer !== undefined ? { answer: dto.answer.trim() } : {}),
      },
    });
    return this.toDto(updated);
  }

  async delete(websiteId: string, faqId: string): Promise<void> {
    const faq = await this.prisma.faqEntry.findFirst({
      where: { id: faqId, websiteId },
    });
    if (!faq) {
      throw new NotFoundException('FAQ not found');
    }
    await this.prisma.faqEntry.delete({ where: { id: faqId } });
  }

  async getByWebsite(websiteId: string): Promise<FaqEntry[]> {
    const faqs = await this.prisma.faqEntry.findMany({
      where: { websiteId },
      orderBy: { createdAt: 'asc' },
    });
    return faqs.map((f) => this.toDto(f));
  }

  private toDto(faq: any): FaqEntry {
    return {
      id: faq.id,
      websiteId: faq.websiteId,
      question: faq.question,
      answer: faq.answer,
      createdAt: faq.createdAt.toISOString(),
      updatedAt: faq.updatedAt.toISOString(),
    };
  }
}
